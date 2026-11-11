// Photos on a lesson: shrinking them on the phone before uploading, showing previews, and a
// full-screen viewer with zoom, share/save and delete. The server keeps each photo private to its account.
import { html } from './html.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { t, tn } from './i18n.js';
import { state } from './store.js';
import { toast, confirmSheet } from './ui.js';

const FULL_EDGE = 1600; // pixels on the long side: sharp enough to read a worksheet
const THUMB_EDGE = 360;
const MAX_CHARS = 1_300_000; // stays under the server's limit (about 1 MB)

// ---------- loaded images ----------

// Images already loaded this session (as data: URLs), so moving around doesn't download them again.
const cache = new Map();
const CACHE_MAX = 60;
const remember = (key, url) => {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
};
window.addEventListener('tp:logout', () => cache.clear());

export async function photoSrc(id, kind = 'thumb') {
  const key = `${id}:${kind}`;
  if (cache.has(key)) return cache.get(key);
  const { type, data } = await api('GET', `/api/photos/${id}${kind === 'thumb' ? '?size=thumb' : ''}`);
  const url = `data:${type};base64,${data}`;
  remember(key, url);
  return url;
}

function setCount(lessonId, n) {
  const counts = { ...state.photoCounts };
  if (n > 0) counts[lessonId] = n;
  else delete counts[lessonId];
  state.photoCounts = counts;
}

// ---------- shrinking before upload ----------

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, done: () => bitmap.close() };
    } catch {
      // fall back to an <img>
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(t('photos.notImage'));
  }
  return { source: img, done: () => URL.revokeObjectURL(url) };
}

function encode(source, edge, quality) {
  const scale = Math.min(1, edge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // see-through images get a white background
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const url = canvas.toDataURL('image/jpeg', quality);
  canvas.width = canvas.height = 0; // frees the memory straight away (matters on iPhone)
  return { data: url.slice(url.indexOf(',') + 1), width, height };
}

// A photo from the camera or library, made small enough to store: { photo, thumb, width, height }.
export async function shrink(file) {
  if (file.type && !file.type.startsWith('image/')) throw new Error(t('photos.notImage'));
  const { source, done } = await decode(file);
  try {
    let full = encode(source, FULL_EDGE, 0.72);
    if (full.data.length > MAX_CHARS) full = encode(source, 1280, 0.6);
    const thumb = encode(source, THUMB_EDGE, 0.6);
    return { photo: full.data, thumb: thumb.data, width: full.width, height: full.height };
  } finally {
    done();
  }
}

// ---------- the Photos card on a lesson ----------

export function photosCard(lessonId) {
  const known = state.photoCounts?.[lessonId] ?? 0;
  return html`
    <section class="card pad" data-photos data-lesson="${lessonId}">
      <div class="card-title-row">
        <h2 class="card-title">${icon('camera')} ${t('photos.title')}</h2>
        <label class="btn small photo-add">
          ${icon('plus')} ${t('photos.add')}
          <input type="file" accept="image/*" multiple class="visually-hidden" data-photo-input>
        </label>
      </div>
      <div class="photo-grid" data-photo-grid>
        ${known ? Array.from({ length: known }, () => html`<div class="photo-tile is-loading"></div>`) : emptyText()}
      </div>
    </section>`;
}

const emptyText = () => html`<p class="muted small photo-empty">${t('photos.empty')}</p>`;
const gridFor = (lessonId) => document.querySelector(`[data-photos][data-lesson="${lessonId}"] [data-photo-grid]`);

async function loadGrid(grid, lessonId) {
  let photos;
  try {
    photos = (await api('GET', `/api/lessons/${lessonId}/photos`)).photos;
  } catch (err) {
    if (grid.isConnected) grid.innerHTML = String(html`<p class="muted small photo-empty">${navigator.onLine === false ? t('photos.offline') : err.message}</p>`);
    return;
  }
  if (!grid.isConnected) return;
  grid.photos = photos;
  setCount(lessonId, photos.length);
  // (Inside html`` so the list is joined without commas between the tiles.)
  grid.innerHTML = String(html`${
    photos.length
      ? photos.map(
          (p, i) => html`<button type="button" class="photo-tile" data-photo-index="${i}" aria-label="${t('photos.open', { i: i + 1, n: photos.length })}"><img alt="" decoding="async"></button>`,
        )
      : emptyText()
  }`);
  // Previews, a few at a time.
  const queue = [...photos.entries()];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [i, p] = next;
      const tile = grid.querySelector(`[data-photo-index="${i}"]`);
      try {
        const src = await photoSrc(p.id, 'thumb');
        if (tile) tile.querySelector('img').src = src;
      } catch {
        tile?.classList.add('is-broken');
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// Wires up the card after the lesson page is drawn.
export function mountPhotos(card) {
  if (!card) return;
  const lessonId = card.dataset.lesson;
  const grid = card.querySelector('[data-photo-grid]');
  const input = card.querySelector('[data-photo-input]');

  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    grid.querySelector('.photo-empty')?.remove();
    for (const _ of files) {
      grid.insertAdjacentHTML('beforeend', String(html`<div class="photo-tile is-uploading"><span class="spinner small"></span><span>${t('photos.uploading')}</span></div>`));
    }
    let added = 0;
    let error = null;
    for (const file of files) {
      try {
        const body = await shrink(file);
        const photo = await api('POST', `/api/lessons/${lessonId}/photos`, body);
        remember(`${photo.id}:thumb`, `data:image/jpeg;base64,${body.thumb}`);
        remember(`${photo.id}:full`, `data:image/jpeg;base64,${body.photo}`);
        added++;
      } catch (err) {
        error ??= err;
      }
    }
    if (error) toast(error.message, { error: true });
    else toast(tn('photos.added', added));
    const current = gridFor(lessonId); // the page may have been redrawn meanwhile
    if (current) await loadGrid(current, lessonId);
  });

  grid.addEventListener('click', (ev) => {
    const tile = ev.target.closest('[data-photo-index]');
    if (tile && grid.photos) openViewer(lessonId, grid.photos, Number(tile.dataset.photoIndex));
  });

  loadGrid(grid, lessonId);
}

// ---------- full-screen viewer ----------

async function sharePhoto(id) {
  const src = await photoSrc(id, 'full');
  const type = src.slice(5, src.indexOf(';'));
  const bytes = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  const file = new File([bytes], `lesson-photo.${type === 'image/png' ? 'png' : 'jpg'}`, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function openViewer(lessonId, photos, start) {
  const list = [...photos];
  let index = start;
  const layer = document.createElement('div');
  layer.className = 'photo-viewer';
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', t('photos.title'));
  layer.innerHTML = String(html`
    <div class="viewer-bar">
      <button type="button" class="viewer-btn" data-viewer="close" aria-label="${t('photos.close')}">${icon('x')}</button>
      <span class="viewer-count" data-viewer-count></span>
      <button type="button" class="viewer-btn" data-viewer="share" aria-label="${t('photos.share')}">${icon('share')}</button>
      <button type="button" class="viewer-btn" data-viewer="delete" aria-label="${t('photos.delete')}">${icon('trash')}</button>
    </div>
    <div class="viewer-stage" data-viewer-stage>
      <img alt="" data-viewer-img>
      <span class="spinner" data-viewer-spinner hidden></span>
    </div>
    <button type="button" class="viewer-nav prev" data-viewer="prev" aria-label="${t('photos.prev')}">${icon('chevronLeft')}</button>
    <button type="button" class="viewer-nav next" data-viewer="next" aria-label="${t('photos.next')}">${icon('chevronRight')}</button>
    <p class="viewer-hint">${t('photos.zoomHint')}</p>`);
  const stage = layer.querySelector('[data-viewer-stage]');
  const img = layer.querySelector('[data-viewer-img]');
  const spinner = layer.querySelector('[data-viewer-spinner]');

  const show = async () => {
    const photo = list[index];
    layer.querySelector('[data-viewer-count]').textContent = t('photos.position', { i: index + 1, n: list.length });
    layer.querySelector('.prev').hidden = index === 0;
    layer.querySelector('.next').hidden = index === list.length - 1;
    stage.classList.remove('zoomed');
    img.src = cache.get(`${photo.id}:thumb`) ?? '';
    spinner.hidden = false;
    try {
      const src = await photoSrc(photo.id, 'full');
      if (list[index] === photo) img.src = src;
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      if (list[index] === photo) spinner.hidden = true;
    }
  };

  const close = () => {
    layer.remove();
    document.body.classList.remove('viewer-open');
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
  };
  const step = (by) => {
    const next = index + by;
    if (next < 0 || next >= list.length) return;
    index = next;
    show();
  };
  const onKey = (ev) => {
    if (document.querySelector('.sheet-layer')) return; // a question is open on top
    if (ev.key === 'Escape') close();
    if (ev.key === 'ArrowLeft') step(-1);
    if (ev.key === 'ArrowRight') step(1);
  };

  // Tap the photo to zoom in on that spot; tap again to fit it to the screen.
  const toggleZoom = (ev) => {
    if (stage.classList.contains('zoomed')) {
      stage.classList.remove('zoomed');
      return;
    }
    const box = img.getBoundingClientRect();
    const fx = (ev.clientX - box.left) / box.width;
    const fy = (ev.clientY - box.top) / box.height;
    stage.classList.add('zoomed');
    stage.scrollLeft = fx * img.offsetWidth - stage.clientWidth / 2;
    stage.scrollTop = fy * img.offsetHeight - stage.clientHeight / 2;
  };

  layer.addEventListener('click', async (ev) => {
    const button = ev.target.closest('[data-viewer]');
    if (!button) {
      if (ev.target === img) toggleZoom(ev);
      return;
    }
    const photo = list[index];
    try {
      switch (button.dataset.viewer) {
        case 'close':
          return close();
        case 'prev':
          return step(-1);
        case 'next':
          return step(1);
        case 'share':
          return await sharePhoto(photo.id);
        case 'delete': {
          const ok = await confirmSheet({ title: t('photos.deleteTitle'), message: t('photos.deleteText'), confirmLabel: t('photos.delete'), danger: true });
          if (!ok) return;
          await api('DELETE', `/api/photos/${photo.id}`);
          cache.delete(`${photo.id}:thumb`);
          cache.delete(`${photo.id}:full`);
          list.splice(index, 1);
          toast(t('photos.deleted'));
          const grid = gridFor(lessonId);
          if (grid) loadGrid(grid, lessonId);
          else setCount(lessonId, list.length);
          if (!list.length) return close();
          index = Math.min(index, list.length - 1);
          return show();
        }
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  // Swipe sideways for the next or previous photo (when not zoomed in).
  let touchX = null;
  stage.addEventListener('touchstart', (ev) => (touchX = ev.touches.length === 1 ? ev.touches[0].clientX : null), { passive: true });
  stage.addEventListener('touchend', (ev) => {
    if (touchX == null || stage.classList.contains('zoomed')) return;
    const dx = ev.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
    touchX = null;
  });

  window.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  document.body.classList.add('viewer-open');
  document.body.append(layer);
  show();
}
