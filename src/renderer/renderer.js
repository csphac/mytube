const $ = (id) => document.getElementById(id);

const els = {
  url: $('url'),
  fetchBtn: $('fetch-btn'),
  toolsStatus: $('tools-status'),
  infoCard: $('info-card'),
  thumb: $('thumb'),
  title: $('title'),
  meta: $('meta'),
  options: $('options'),
  optVideo: $('opt-video'),
  optTranscript: $('opt-transcript'),
  optSlides: $('opt-slides'),
  quality: $('quality'),
  lang: $('lang'),
  langHint: $('lang-hint'),
  sensitivity: $('sensitivity'),
  destRow: $('dest-row'),
  destPath: $('dest-path'),
  pickBtn: $('pick-btn'),
  actionRow: $('action-row'),
  downloadBtn: $('download-btn'),
  cancelBtn: $('cancel-btn'),
  progressPanel: $('progress-panel'),
  stageLabel: $('stage-label'),
  percentLabel: $('percent-label'),
  progressBar: $('progress-bar'),
  log: $('log'),
  donePanel: $('done-panel'),
  doneText: $('done-text'),
  openBtn: $('open-btn'),
  errorPanel: $('error-panel'),
  downloadView: $('download-view'),
  detailView: $('detail-view'),
  newDownloadBtn: $('new-download-btn'),
  refreshBtn: $('refresh-btn'),
  libList: $('lib-list'),
  libEmpty: $('lib-empty'),
  dThumb: $('d-thumb'),
  dTitle: $('d-title'),
  dMeta: $('d-meta'),
  dFolder: $('d-folder'),
  dOpenFolder: $('d-open-folder'),
  dDelete: $('d-delete'),
  dVideo: $('d-video'),
  dVideoInfo: $('d-video-info'),
  dPlay: $('d-play'),
  dShowVideo: $('d-show-video'),
  dTranscript: $('d-transcript'),
  dOpenTxt: $('d-open-txt'),
  dOpenSrt: $('d-open-srt'),
  dTranscriptText: $('d-transcript-text'),
  dSlides: $('d-slides'),
  dSlideCount: $('d-slide-count'),
  dOpenGallery: $('d-open-gallery'),
  dSlideGrid: $('d-slide-grid'),
  dSlideMore: $('d-slide-more'),
  deleteOverlay: $('delete-overlay'),
  deleteText: $('delete-text'),
  deleteCancel: $('delete-cancel'),
  deleteConfirm: $('delete-confirm'),
  toast: $('toast'),
};

let info = null;
let outputDir = '';
let downloading = false;
let doneFolder = '';
let transcriptAvailable = false;
let libraryItems = [];
let currentItem = null;
let deleteTarget = null;
let toastTimer = null;

const TRASH_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

function show(el, visible) {
  el.classList.toggle('hidden', !visible);
}

function mediaUrl(p) {
  return 'media://local' + p.split('/').map(encodeURIComponent).join('/');
}

function fmtDuration(s) {
  if (!s) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function fmtViews(n) {
  if (n == null) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M views';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K views';
  return n + ' views';
}

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.round(n / 1e3) + ' KB';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function appendLog(text) {
  const line = document.createElement('div');
  line.textContent = text;
  els.log.appendChild(line);
  while (els.log.childElementCount > 400) els.log.firstChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}

function setProgress(percent, message) {
  if (percent != null) {
    els.progressBar.style.width = percent + '%';
    els.percentLabel.textContent = Math.round(percent) + '%';
  }
  if (message) els.stageLabel.textContent = message;
}

function syncCards() {
  els.optTranscript.disabled = !transcriptAvailable;
  $('card-video').classList.toggle('active', els.optVideo.checked);
  $('card-transcript').classList.toggle('active', els.optTranscript.checked);
  $('card-slides').classList.toggle('active', els.optSlides.checked);
  if (els.optSlides.checked) {
    els.optVideo.checked = true;
    els.optVideo.disabled = true;
    $('card-video').classList.add('active');
  } else {
    els.optVideo.disabled = false;
  }
}

function setBusy(busy) {
  downloading = busy;
  els.fetchBtn.disabled = busy;
  els.url.disabled = busy;
  els.downloadBtn.disabled = busy;
  els.pickBtn.disabled = busy;
  [els.optVideo, els.optTranscript, els.optSlides, els.quality, els.lang, els.sensitivity].forEach(
    (el) => (el.disabled = busy)
  );
  show(els.cancelBtn, busy);
  if (!busy) syncCards();
}

function showView(view) {
  show(els.downloadView, view === 'download');
  show(els.detailView, view === 'detail');
  els.newDownloadBtn.classList.toggle('active', view === 'download');
  if (view === 'download') {
    currentItem = null;
    renderLibrary();
  }
}

function itemThumb(item) {
  if (item.thumbnail) return item.thumbnail;
  if (item.slides.files.length) return mediaUrl(item.slides.dir + '/' + item.slides.files[0]);
  return null;
}

function renderLibrary() {
  els.libList.innerHTML = '';
  show(els.libEmpty, libraryItems.length === 0);
  for (const item of libraryItems) {
    const row = document.createElement('div');
    row.className = 'lib-item';
    if (currentItem && currentItem.folder === item.folder) row.classList.add('active');

    const btn = document.createElement('button');
    btn.className = 'lib-main';

    const thumbSrc = itemThumb(item);
    if (thumbSrc) {
      const img = document.createElement('img');
      img.className = 'lib-thumb';
      img.src = thumbSrc;
      img.alt = '';
      btn.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'lib-thumb placeholder';
      ph.textContent = '▶';
      btn.appendChild(ph);
    }

    const text = document.createElement('span');
    text.className = 'lib-item-text';
    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = item.title;
    const sub = document.createElement('span');
    sub.className = 'lib-sub';
    const badges = [
      ['V', !!item.video, 'Video'],
      ['T', !!(item.transcript.txt || item.transcript.srt), 'Transcript'],
      ['S', item.slides.files.length > 0, 'Slides'],
    ];
    for (const [letter, on, label] of badges) {
      const b = document.createElement('span');
      b.className = 'badge' + (on ? ' on' : '');
      b.textContent = letter;
      b.title = label + (on ? '' : ' (not downloaded)');
      sub.appendChild(b);
    }
    const date = document.createElement('span');
    date.textContent = fmtDate(item.downloadedAt);
    sub.appendChild(date);
    text.appendChild(title);
    text.appendChild(sub);
    btn.appendChild(text);

    btn.addEventListener('click', () => selectItem(item));

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.title = 'Delete download';
    del.setAttribute('aria-label', 'Delete ' + item.title);
    del.innerHTML = TRASH_SVG;
    del.addEventListener('click', () => openDeleteDialog(item));

    row.appendChild(btn);
    row.appendChild(del);
    els.libList.appendChild(row);
  }
}

async function loadLibrary() {
  const result = await window.mytube.libraryList();
  libraryItems = result.ok ? result.items : [];
  renderLibrary();
}

function showToast(message) {
  els.toast.textContent = message;
  show(els.toast, true);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(els.toast, false), 2600);
}

function openDeleteDialog(item) {
  deleteTarget = item;
  els.deleteText.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = `“${item.title}”`;
  els.deleteText.appendChild(strong);
  els.deleteText.appendChild(
    document.createTextNode(
      ' will be permanently removed from disk — video, transcript and slides. This cannot be undone.'
    )
  );
  els.deleteConfirm.disabled = false;
  show(els.deleteOverlay, true);
  els.deleteCancel.focus();
}

function closeDeleteDialog() {
  show(els.deleteOverlay, false);
  deleteTarget = null;
}

async function confirmDelete() {
  const item = deleteTarget;
  if (!item) return;
  els.deleteConfirm.disabled = true;
  const result = await window.mytube.libraryDelete(item.folder);
  els.deleteConfirm.disabled = false;
  if (!result.ok) {
    els.deleteText.textContent = 'Delete failed: ' + result.error;
    return;
  }
  closeDeleteDialog();
  libraryItems = libraryItems.filter((it) => it.folder !== item.folder);
  if (currentItem && currentItem.folder === item.folder) showView('download');
  renderLibrary();
  showToast(`Deleted “${item.title}”`);
}

async function selectItem(item) {
  currentItem = item;
  showView('detail');
  renderLibrary();

  const thumbSrc = itemThumb(item);
  if (thumbSrc) {
    els.dThumb.src = thumbSrc;
    show(els.dThumb, true);
  } else {
    show(els.dThumb, false);
  }
  els.dTitle.textContent = item.title;
  els.dMeta.textContent = [item.channel, fmtDuration(item.duration), fmtDate(item.downloadedAt)]
    .filter(Boolean)
    .join(' · ');
  els.dFolder.textContent = item.folder;

  show(els.dVideo, !!item.video);
  if (item.video) {
    els.dVideoInfo.textContent =
      item.video.file.split('/').pop() + ' · ' + fmtBytes(item.video.size);
  }

  const hasTranscript = !!(item.transcript.txt || item.transcript.srt);
  show(els.dTranscript, hasTranscript);
  if (hasTranscript) {
    els.dOpenTxt.disabled = !item.transcript.txt;
    els.dOpenSrt.disabled = !item.transcript.srt;
    els.dTranscriptText.textContent = 'Loading…';
    if (item.transcript.txt) {
      const res = await window.mytube.libraryTranscript(item.folder);
      if (currentItem === item) {
        els.dTranscriptText.textContent = res.ok ? res.text : res.error;
      }
    } else {
      els.dTranscriptText.textContent = 'Only the timestamped .srt file is available.';
    }
  }

  const slideCount = item.slides.files.length;
  show(els.dSlides, slideCount > 0);
  if (slideCount > 0) {
    els.dSlideCount.textContent = slideCount;
    els.dOpenGallery.disabled = !item.slides.gallery;
    els.dSlideGrid.innerHTML = '';
    const preview = item.slides.files.slice(0, 12);
    for (const file of preview) {
      const img = document.createElement('img');
      img.src = mediaUrl(item.slides.dir + '/' + file);
      img.alt = file;
      img.title = file;
      img.addEventListener('click', () =>
        window.mytube.openPath(item.slides.dir + '/' + file)
      );
      els.dSlideGrid.appendChild(img);
    }
    show(els.dSlideMore, slideCount > preview.length);
    if (slideCount > preview.length) {
      els.dSlideMore.textContent = `+ ${slideCount - preview.length} more — open the gallery to see all.`;
    }
  }
}

async function init() {
  outputDir = await window.mytube.getDefaultDir();
  els.destPath.textContent = outputDir;

  window.mytube.onToolsProgress((p) => {
    els.toolsStatus.textContent =
      p.message + (p.percent != null ? ` ${p.percent}%` : '');
  });
  const tools = await window.mytube.ensureTools();
  if (tools.ok) {
    els.toolsStatus.textContent = 'Tools ready';
    els.toolsStatus.classList.add('ready');
  } else {
    els.toolsStatus.textContent = 'Tool setup failed: ' + tools.error;
    els.toolsStatus.classList.add('error');
  }

  window.mytube.onDownloadEvent((event) => {
    if (event.type === 'error' || event.type === 'cancelled') return;
    const stageNames = { video: 'Video', transcript: 'Transcript', slides: 'Slides' };
    const prefix = event.stage
      ? `${stageNames[event.stage] || event.stage} (${event.stageIndex + 1}/${event.stageCount}) — `
      : '';
    setProgress(event.percent, prefix + (event.message || ''));
    if (event.message) appendLog(prefix + event.message);
  });

  await loadLibrary();
}

async function fetchVideo() {
  const url = els.url.value.trim();
  if (!url) return;
  show(els.errorPanel, false);
  show(els.donePanel, false);
  els.fetchBtn.disabled = true;
  els.fetchBtn.textContent = 'Fetching…';
  const result = await window.mytube.fetchInfo(url);
  els.fetchBtn.disabled = false;
  els.fetchBtn.textContent = 'Fetch';
  if (!result.ok) {
    els.errorPanel.textContent = result.error;
    show(els.errorPanel, true);
    return;
  }
  info = result.info;
  els.thumb.src = info.thumbnail || '';
  els.title.textContent = info.title;
  els.meta.textContent = [
    info.channel,
    fmtDuration(info.duration),
    fmtViews(info.viewCount),
  ]
    .filter(Boolean)
    .join(' · ');

  els.lang.innerHTML = '';
  transcriptAvailable = info.languages.length > 0;
  if (info.languages.length === 0) {
    els.optTranscript.checked = false;
    els.optTranscript.disabled = true;
    els.langHint.textContent = 'No captions or transcripts are available for this video.';
    const opt = document.createElement('option');
    opt.textContent = 'None available';
    els.lang.appendChild(opt);
  } else {
    els.optTranscript.disabled = false;
    els.langHint.textContent =
      'Plain text + SRT with timestamps. Auto-generated captions used when no manual ones exist.';
    for (const l of info.languages) {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.label;
      els.lang.appendChild(opt);
    }
  }

  show(els.infoCard, true);
  show(els.options, true);
  show(els.destRow, true);
  show(els.actionRow, true);
  syncCards();
}

async function startDownload() {
  if (!info || downloading) return;
  if (!els.optVideo.checked && !els.optTranscript.checked && !els.optSlides.checked) {
    els.errorPanel.textContent = 'Select at least one item to download.';
    show(els.errorPanel, true);
    return;
  }
  show(els.errorPanel, false);
  show(els.donePanel, false);
  show(els.progressPanel, true);
  els.log.innerHTML = '';
  setProgress(0, 'Starting…');
  setBusy(true);
  appendLog('Saving to ' + outputDir);

  const opts = {
    url: els.url.value.trim(),
    outputDir,
    info,
    video: {
      enabled: els.optVideo.checked,
      height: Number(els.quality.value) || 0,
    },
    transcript: {
      enabled: els.optTranscript.checked,
      lang: els.lang.value,
    },
    slides: {
      enabled: els.optSlides.checked,
      threshold: Number(els.sensitivity.value),
    },
  };

  const result = await window.mytube.startDownload(opts);
  setBusy(false);
  if (result.ok) {
    doneFolder = result.folder;
    setProgress(100, 'Done');
    els.doneText.textContent = 'Saved to ' + result.folder;
    show(els.donePanel, true);
    appendLog('Done: ' + result.folder);
    await loadLibrary();
  } else if (result.cancelled) {
    setProgress(null, 'Cancelled');
    appendLog('Cancelled.');
  } else {
    els.errorPanel.textContent = result.error;
    show(els.errorPanel, true);
    appendLog('Error: ' + result.error);
  }
}

els.fetchBtn.addEventListener('click', fetchVideo);
els.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchVideo();
});
els.downloadBtn.addEventListener('click', startDownload);
els.cancelBtn.addEventListener('click', () => window.mytube.cancelDownload());
els.pickBtn.addEventListener('click', async () => {
  const picked = await window.mytube.pickFolder();
  if (picked) {
    outputDir = picked;
    els.destPath.textContent = picked;
  }
});
els.openBtn.addEventListener('click', () => {
  if (doneFolder) window.mytube.openPath(doneFolder);
});
[els.optVideo, els.optTranscript, els.optSlides].forEach((el) =>
  el.addEventListener('change', syncCards)
);

els.newDownloadBtn.addEventListener('click', () => showView('download'));
els.refreshBtn.addEventListener('click', loadLibrary);
els.dOpenFolder.addEventListener('click', () => {
  if (currentItem) window.mytube.openPath(currentItem.folder);
});
els.dPlay.addEventListener('click', () => {
  if (currentItem?.video) window.mytube.openPath(currentItem.video.file);
});
els.dShowVideo.addEventListener('click', () => {
  if (currentItem?.video) window.mytube.showItem(currentItem.video.file);
});
els.dOpenTxt.addEventListener('click', () => {
  if (currentItem?.transcript.txt) window.mytube.openPath(currentItem.transcript.txt);
});
els.dOpenSrt.addEventListener('click', () => {
  if (currentItem?.transcript.srt) window.mytube.openPath(currentItem.transcript.srt);
});
els.dOpenGallery.addEventListener('click', () => {
  if (currentItem?.slides.gallery) window.mytube.openPath(currentItem.slides.gallery);
});
els.dDelete.addEventListener('click', () => {
  if (currentItem) openDeleteDialog(currentItem);
});
els.deleteCancel.addEventListener('click', closeDeleteDialog);
els.deleteConfirm.addEventListener('click', confirmDelete);
els.deleteOverlay.addEventListener('click', (e) => {
  if (e.target === els.deleteOverlay) closeDeleteDialog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.deleteOverlay.classList.contains('hidden')) {
    closeDeleteDialog();
  }
});

init();