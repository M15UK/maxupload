import { AppError } from './app-error.js';
import { DEFAULT_SETTINGS, MODE_GROUPS, SETTING_GROUPS, planEncode } from './encode-plan.js';
import { formatBitrate, formatBytes, formatDuration, outputFileName } from './format.js';
import { LANGUAGES, detectLanguage, hasMessage, isolate, translate, translateError } from './i18n.js';

// Loaded lazily so the page still renders (and can explain the problem) if the CDN is unreachable.
const converterModule = import('./converter.js');
const loadConverter = () =>
  converterModule.catch(() => {
    throw new AppError('libraryLoad');
  });
const ENCODING_SUPPORTED = 'VideoEncoder' in window;

const STEPS = ['video', 'settings', 'download'];
const SECTION_STEP = Object.freeze({
  'step-video': 'video',
  'step-settings': 'settings',
  'step-convert': 'download',
  'step-done': 'download',
});
// Small labels next to an option's title ("group.value") or a group's title ("group").
const OPTION_TAGS = Object.freeze({
  'resolution.1080p': 'recommended',
  'frameRate.max60': 'recommended',
  'frameRate.max120': 'beta',
  'method.variant-1': 'recommended',
  'method.variant-3': 'beta',
});
const GROUP_TAGS = Object.freeze({ enhance: 'optional' });
const OTHER_LANGUAGE = Object.freeze({ en: 'ar', ar: 'en' });
const LANGUAGE_STORAGE_KEY = 'maxupload.language';
const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|mkv|webm)$/i;
const MIN_PROGRESS_FOR_ETA = 0.02;
const CODEC_NAMES = Object.freeze({ avc: 'H.264', hevc: 'HEVC' });

const $ = (id) => document.getElementById(id);
const dom = {
  homeLink: $('home-link'),
  languageToggle: $('language-toggle'),
  unsupported: $('unsupported'),
  error: $('error'),
  dropzone: $('dropzone'),
  dropzoneTitle: $('dropzone-title'),
  fileInput: $('file-input'),
  sourceName: $('source-name'),
  sourceMeta: $('source-meta'),
  settingsForm: $('settings-form'),
  plan: $('plan'),
  warnings: $('warnings'),
  start: $('start'),
  progress: $('progress'),
  progressText: $('progress-text'),
  cancel: $('cancel'),
  doneHeading: $('done-heading'),
  preview: $('preview'),
  resultMeta: $('result-meta'),
  resultWarnings: $('result-warnings'),
  downloadUpload: $('download-upload'),
  downloadPreview: $('download-preview'),
  patchInstructions: $('patch-instructions'),
  changeVideo: $('change-video'),
  convertAnother: $('convert-another'),
};

let state = Object.freeze({
  language: 'en',
  file: null,
  source: null,
  settings: DEFAULT_SETTINGS,
  isReading: false,
  error: null, // { error, fallbackCode } — translated on render so it follows language changes
  progress: null, // { fraction, startedAt }
  abortController: null,
  output: null, // { result, plan, previewUrl, uploadUrl }
});

function setState(patch) {
  state = Object.freeze({ ...state, ...patch });
}

const t = (key, params) => translate(state.language, key, params);

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

// "1080×1920 · 120 fps · 13.0 MB": each part is isolated so it stays intact in Arabic (RTL) order.
const joinParts = (parts) => parts.map(isolate).join(' · ');

// ---------- Shared rendering ----------

function renderError() {
  const message = state.error ? translateError(state.language, state.error.error, state.error.fallbackCode) : '';
  dom.error.textContent = message;
  dom.error.hidden = !message;
}

function showError(error, fallbackCode = 'conversionFailed') {
  setState({ error: error ? { error, fallbackCode } : null });
  renderError();
}

function showSection(sectionId) {
  Object.keys(SECTION_STEP).forEach((id) => {
    $(id).hidden = id !== sectionId;
  });
  const activeIndex = STEPS.indexOf(SECTION_STEP[sectionId]);
  document.querySelectorAll('.steps li').forEach((item, index) => {
    item.classList.toggle('is-active', index === activeIndex);
    item.classList.toggle('is-done', index < activeIndex);
    if (index === activeIndex) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

function tagElement(tag) {
  return textElement('span', t(`tag.${tag}`), `tag tag--${tag}`);
}

/** A title with an optional tag after it, e.g. "1080p [Recommended]". */
function titleWithTag(tag, text, tagName, className) {
  const title = textElement(tag, text, className);
  if (tagName) title.append(' ', tagElement(tagName));
  return title;
}

function renderOptions(container, name, choices, keyPrefix, selected) {
  const options = choices.map((value) => {
    const key = `${keyPrefix}.${value}`;
    const option = document.createElement('label');
    option.className = 'option';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name, value });
    input.checked = value === selected;
    const text = document.createElement('span');
    text.className = 'option__text';
    text.append(titleWithTag('strong', t(key), OPTION_TAGS[key], 'option__title'));
    // Hints are optional: some options are clear from their title alone.
    if (hasMessage(state.language, `${key}.hint`)) text.append(textElement('span', t(`${key}.hint`), 'option__hint'));
    option.append(input, text);
    return option;
  });
  container.replaceChildren(...options);
}

function settingFieldset(group) {
  const fieldset = document.createElement('fieldset');
  const options = document.createElement('div');
  options.className = 'options';
  renderOptions(options, group, SETTING_GROUPS[group], group, state.settings[group]);
  fieldset.append(titleWithTag('legend', t(`settings.${group}`), GROUP_TAGS[group]), options);
  return fieldset;
}

/** Shows the mode choice, then only the settings that belong to the chosen mode. */
function renderSettingOptions() {
  const groups = ['mode', ...MODE_GROUPS[state.settings.mode]];
  dom.settingsForm.replaceChildren(...groups.map(settingFieldset));
}

// ---------- Language ----------

function readSavedLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null; // Storage blocked (private mode, etc.): fall back to the browser language.
  }
}

function saveLanguage(language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Remembering the choice is a convenience only; the page works without it.
  }
}

function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  });
  document.querySelectorAll('[data-i18n-content]').forEach((element) => {
    element.setAttribute('content', t(element.dataset.i18nContent));
  });
}

function setLanguage(language) {
  setState({ language });
  const { htmlLang, dir } = LANGUAGES[language];
  document.documentElement.lang = htmlLang;
  document.documentElement.dir = dir;
  dom.languageToggle.lang = LANGUAGES[OTHER_LANGUAGE[language]].htmlLang;
  applyStaticTranslations();
  renderSettingOptions();
  setDropzoneBusy(state.isReading);
  renderError();
  if (state.source) {
    renderSource();
    renderPlan();
  }
  if (state.progress) renderProgress();
  if (state.output) renderResult();
}

// ---------- Step 1: choose a video ----------

const isLikelyVideo = (file) => file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name);

function setDropzoneBusy(isReading) {
  setState({ isReading });
  const isBlocked = isReading || !ENCODING_SUPPORTED;
  dom.dropzone.classList.toggle('is-busy', isBlocked);
  dom.fileInput.disabled = isBlocked;
  dom.dropzoneTitle.textContent = t(isReading ? 'video.reading' : 'video.select');
}

async function handleFile(file) {
  if (!file) return;
  if (!isLikelyVideo(file)) {
    showError(new AppError('notVideo'));
    return;
  }
  showError(null);
  setDropzoneBusy(true);
  try {
    const { probeVideo } = await loadConverter();
    const source = await probeVideo(file);
    setState({ file, source });
    renderSource();
    renderPlan();
    showSection('step-settings');
  } catch (error) {
    showError(error, 'unreadable');
  } finally {
    setDropzoneBusy(false);
    dom.fileInput.value = '';
  }
}

// ---------- Step 2: settings and plan ----------

function renderSource() {
  const { file, source } = state;
  dom.sourceName.textContent = file.name;
  dom.sourceMeta.textContent = joinParts([
    `${source.width}×${source.height}`,
    t('unit.fps', { fps: source.frameRate.toFixed(2) }),
    formatDuration(source.duration),
    formatBytes(file.size),
    t(source.hasAudio ? 'source.withAudio' : 'source.noAudio'),
  ]);
}

// Only the current mode's groups are on screen; the other mode keeps its earlier choices.
function readSettings() {
  const shown = Object.fromEntries(new FormData(dom.settingsForm).entries());
  return Object.freeze({ ...state.settings, ...shown });
}

function planReadout(plan) {
  const common = [
    { label: t('plan.codec'), value: CODEC_NAMES[plan.codec], highlight: plan.codec === 'hevc' },
    { label: t('plan.resolution'), value: `${plan.width}×${plan.height}` },
    { label: t('plan.frameRate'), value: t('unit.fps', { fps: plan.frameRate }), highlight: true },
    { label: t('plan.videoBitrate'), value: formatBitrate(plan.videoBitrate) },
    { label: t('plan.audio'), value: t(plan.audioBitrate > 0 ? 'plan.audioAac' : 'plan.audioNone') },
    { label: t('plan.size'), value: `≈ ${formatBytes(plan.estimatedBytes)}` },
  ];
  if (plan.mode !== 'tiktok') return common;
  return [
    ...common,
    { label: t('plan.enhance'), value: t(`enhance.${state.settings.enhance}`), highlight: Boolean(plan.enhance) },
    { label: t('plan.method'), value: plan.method ? t(`method.${plan.method}`) : t('plan.methodNone'), highlight: Boolean(plan.method) },
  ];
}

function specCell({ label, value, highlight }) {
  const cell = document.createElement('div');
  if (highlight) cell.className = 'is-highlight';
  // Isolated so "1080×1920" and "≈ 13.0 MB" stay intact yet align with the page direction.
  cell.append(textElement('dt', label), textElement('dd', isolate(value)));
  return cell;
}

/** Renders the plan for the current settings; returns it, or null when the settings can't work. */
function renderPlan() {
  try {
    const plan = planEncode(state.source, state.settings);
    dom.plan.replaceChildren(...planReadout(plan).map(specCell));
    dom.warnings.replaceChildren(...plan.warnings.map(({ code, params }) => textElement('li', t(`warning.${code}`, params))));
    dom.start.disabled = false;
    return plan;
  } catch (error) {
    dom.plan.replaceChildren(textElement('div', translateError(state.language, error, 'conversionFailed'), 'plan-error'));
    dom.warnings.replaceChildren();
    dom.start.disabled = true;
    return null;
  }
}

// ---------- Step 3: convert and download ----------

function renderProgress() {
  const { fraction, startedAt } = state.progress;
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const status = t('convert.progress', { percent: `${(fraction * 100).toFixed(1)}%`, elapsed: formatDuration(elapsedSeconds) });
  const remaining =
    fraction > MIN_PROGRESS_FOR_ETA
      ? t('convert.remaining', { remaining: formatDuration((elapsedSeconds * (1 - fraction)) / fraction) })
      : '';
  dom.progress.value = fraction;
  dom.progressText.textContent = fraction > 0 ? status + remaining : t('convert.starting');
}

function updateProgress(fraction, startedAt) {
  setState({ progress: { fraction, startedAt } });
  renderProgress();
}

function releaseOutput() {
  if (!state.output) return;
  new Set([state.output.previewUrl, state.output.uploadUrl]).forEach((url) => URL.revokeObjectURL(url));
  setState({ output: null });
}

function storeOutput(result, plan) {
  releaseOutput();
  const previewUrl = URL.createObjectURL(result.previewFile);
  const uploadUrl = result.methodApplied ? URL.createObjectURL(result.uploadFile) : previewUrl;
  setState({ output: { result, plan, previewUrl, uploadUrl } });
  dom.preview.src = previewUrl;
}

function resultWarnings(result, plan) {
  return [
    plan.method && !result.methodApplied && { key: 'warning.methodFailed', params: { detail: result.methodError } },
    result.audioDropped && { key: 'warning.audioDropped' },
  ].filter(Boolean);
}

function renderResult() {
  const { result, plan, previewUrl, uploadUrl } = state.output;
  const patched = result.methodApplied;
  const isCompress = plan.mode === 'compress';
  const tag = `${Math.min(plan.width, plan.height)}p${plan.frameRate}`;
  dom.doneHeading.textContent = t(isCompress ? 'done.headingCompress' : 'done.heading');
  dom.downloadUpload.href = uploadUrl;
  dom.downloadUpload.download = outputFileName(state.file.name, `${isCompress ? 'compressed' : 'tiktok'}_${tag}`);
  dom.downloadUpload.textContent = t(isCompress ? 'done.downloadCompressed' : 'done.downloadUpload', {
    size: formatBytes(result.uploadFile.size),
  });
  dom.downloadPreview.href = previewUrl;
  dom.downloadPreview.download = outputFileName(state.file.name, `${tag}_normal`);
  dom.downloadPreview.hidden = !patched;
  dom.patchInstructions.hidden = !patched;
  dom.resultMeta.textContent = joinParts([
    `${plan.width}×${plan.height}`,
    t('unit.fps', { fps: plan.frameRate }),
    result.codecLabel,
    formatBytes(result.uploadFile.size),
  ]);
  dom.resultWarnings.replaceChildren(
    ...resultWarnings(result, plan).map(({ key, params }) => textElement('li', t(key, params))),
  );
}

async function startConversion() {
  const plan = renderPlan();
  if (!plan) return;
  const controller = new AbortController();
  const startedAt = performance.now();
  setState({ abortController: controller });
  showError(null);
  showSection('step-convert');
  updateProgress(0, startedAt);
  try {
    const { convertVideo } = await loadConverter();
    const result = await convertVideo(state.file, plan, {
      signal: controller.signal,
      onProgress: (fraction) => updateProgress(fraction, startedAt),
    });
    if (controller.signal.aborted) return; // The user left (Cancel or the logo) as it finished.
    storeOutput(result, plan);
    renderResult();
    showSection('step-done');
  } catch (error) {
    // After the logo resets the page there is no video left to return to.
    if (state.source) showSection('step-settings');
    if (!controller.signal.aborted) showError(error, 'conversionFailed');
  } finally {
    setState({ abortController: null, progress: null });
  }
}

function resetToStart() {
  state.abortController?.abort();
  releaseOutput();
  dom.preview.removeAttribute('src');
  dom.preview.load();
  setState({ file: null, source: null });
  showError(null);
  showSection('step-video');
}

// ---------- Wiring ----------

function wireDropzone() {
  dom.fileInput.addEventListener('change', () => handleFile(dom.fileInput.files?.[0]));
  dom.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dom.dropzone.classList.add('is-dragging');
  });
  dom.dropzone.addEventListener('dragleave', () => dom.dropzone.classList.remove('is-dragging'));
  dom.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove('is-dragging');
    handleFile(event.dataTransfer?.files?.[0]);
  });
}

function wireControls() {
  dom.homeLink.addEventListener('click', (event) => {
    event.preventDefault();
    resetToStart();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  dom.languageToggle.addEventListener('click', () => {
    const language = OTHER_LANGUAGE[state.language];
    saveLanguage(language);
    setLanguage(language);
  });
  dom.settingsForm.addEventListener('change', () => {
    const settings = readSettings();
    const modeChanged = settings.mode !== state.settings.mode;
    setState({ settings });
    if (modeChanged) renderSettingOptions();
    renderPlan();
  });
  dom.start.addEventListener('click', startConversion);
  dom.cancel.addEventListener('click', () => state.abortController?.abort());
  dom.changeVideo.addEventListener('click', resetToStart);
  dom.convertAnother.addEventListener('click', resetToStart);
  window.addEventListener('beforeunload', (event) => {
    if (state.abortController) event.preventDefault();
  });
}

function init() {
  dom.unsupported.hidden = ENCODING_SUPPORTED;
  wireDropzone();
  wireControls();
  setLanguage(detectLanguage(readSavedLanguage(), navigator.languages ?? []));
  showSection('step-video');
  converterModule.catch(() => showError(new AppError('libraryLoad')));
}

init();
