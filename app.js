/* 楽譜スクロール — PDF・写真の楽譜を自動スクロールで表示するオフライン対応Webアプリ */
(function () {
  'use strict';

  // ---------- 保存（IndexedDB） ----------
  const DB_NAME = 'score-scroll';
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('scores')) d.createObjectStore('scores', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages');
          if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbp;
  }
  function tx(stores, mode, fn) {
    return db().then((d) => new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('保存に失敗しました'));
    }));
  }
  function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  const store = {
    all: () => tx(['scores'], 'readonly', (t) => reqP(t.objectStore('scores').getAll())),
    get: (id) => tx(['scores'], 'readonly', (t) => reqP(t.objectStore('scores').get(id))),
    put: (s) => tx(['scores'], 'readwrite', (t) => { t.objectStore('scores').put(s); }),
    putPage: (id, i, blob) => tx(['pages'], 'readwrite', (t) => { t.objectStore('pages').put(blob, id + ':' + i); }),
    getPage: (id, i) => tx(['pages'], 'readonly', (t) => reqP(t.objectStore('pages').get(id + ':' + i))),
    folders: () => tx(['folders'], 'readonly', (t) => reqP(t.objectStore('folders').getAll())),
    putFolder: (f) => tx(['folders'], 'readwrite', (t) => { t.objectStore('folders').put(f); }),
    removeFolder: (id) => tx(['folders', 'scores'], 'readwrite', (t) => {
      t.objectStore('folders').delete(id);
      const req = t.objectStore('scores').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (c.value.folder === id) { const v = c.value; v.folder = null; c.update(v); }
        c.continue();
      };
    }),
    remove: (s) => tx(['scores', 'pages'], 'readwrite', (t) => {
      t.objectStore('scores').delete(s.id);
      for (let i = 0; i < s.pageCount; i++) t.objectStore('pages').delete(s.id + ':' + i);
    })
  };

  // ---------- 画面の部品 ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    library: $('library'), grid: $('grid'), empty: $('empty'), emptyText: $('emptyText'), fileInput: $('fileInput'),
    busy: $('busy'), busyText: $('busyText'), busyBar: $('busyBar'),
    viewer: $('viewer'), scroller: $('scroller'), pages: $('pages'), title: $('title'),
    controls: $('controls'), playBtn: $('playBtn'), icoPlay: $('icoPlay'), icoPause: $('icoPause'),
    topBtn: $('topBtn'), backBtn: $('backBtn'), speed: $('speed'), speedVal: $('speedVal'),
    slower: $('slower'), faster: $('faster'), perPage: $('perPage'), countSel: $('countSel'), widthSel: $('widthSel'),
    folderBar: $('folderBar'), sheet: $('sheet'), sheetTitle: $('sheetTitle'), sheetList: $('sheetList'),
    mini: $('mini'), miniSpeed: $('miniSpeed'), countdown: $('countdown'), countNum: $('countNum'), toast: $('toast')
  };

  function showBusy(text, ratio) {
    el.busy.classList.remove('hidden');
    el.busyText.textContent = text;
    el.busyBar.style.width = Math.round((ratio || 0) * 100) + '%';
  }
  function hideBusy() { el.busy.classList.add('hidden'); }
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800);
  }

  // ---------- 取り込み ----------
  const MAX_W = 1600; // 保存する画像の横幅（ピクセル）
  const WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js';
  let workerReady = null;
  // 部品を（オフライン用の保存から）読み込み、同じ場所のファイルとして動かす
  function ensureWorker() {
    if (!workerReady) {
      workerReady = fetch(WORKER_URL).then((r) => {
        if (!r.ok) throw new Error('PDFの部品を読み込めませんでした');
        return r.text();
      }).then((code) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      }).catch((e) => { workerReady = null; throw e; });
    }
    return workerReady;
  }

  function canvasToBlob(c) {
    return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.86));
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function baseName(n) { return n.replace(/\.[^.]+$/, ''); }

  async function importPdf(file) {
    if (!window.pdfjsLib) throw new Error('PDFの部品がまだ読み込まれていません。一度ネットにつないで開き直してください。');
    await ensureWorker();
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const id = newId();
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    for (let i = 1; i <= pdf.numPages; i++) {
      showBusy('「' + baseName(file.name) + '」を読み込み中… ' + i + ' / ' + pdf.numPages, (i - 1) / pdf.numPages);
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(MAX_W / v1.width, 4);
      const vp = page.getViewport({ scale });
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      await store.putPage(id, i - 1, await canvasToBlob(c));
      page.cleanup();
    }
    await pdf.destroy();
    await store.put(newScore(id, baseName(file.name), pdf.numPages));
  }

  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像を開けませんでした: ' + file.name)); };
      img.src = url;
    });
  }

  async function importImages(files) {
    files.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
    const id = newId();
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    for (let i = 0; i < files.length; i++) {
      showBusy('写真を読み込み中… ' + (i + 1) + ' / ' + files.length, i / files.length);
      const img = await loadImage(files[i]);
      const s = Math.min(1, MAX_W / img.naturalWidth);
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      await store.putPage(id, i, await canvasToBlob(c));
    }
    await store.put(newScore(id, baseName(files[0].name), files.length));
  }

  function newScore(id, title, pageCount) {
    const folder = (curFolder !== 'all' && curFolder !== 'none') ? curFolder : null;
    return { id, title, pageCount, created: Date.now(), speed: 10, countIn: 3, width: 100, pos: 0, folder };
  }

  el.fileInput.addEventListener('change', async () => {
    const files = Array.from(el.fileInput.files || []);
    el.fileInput.value = '';
    if (!files.length) return;
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = files.filter((f) => !pdfs.includes(f));
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      for (const f of pdfs) await importPdf(f);
      if (imgs.length) await importImages(imgs);
      hideBusy();
      await renderLibrary();
      toast('楽譜を追加しました');
    } catch (e) {
      hideBusy();
      console.error(e);
      alert('読み込めませんでした。\n' + (e && e.message ? e.message : e));
      renderLibrary();
    }
  });

  // ---------- フォルダ ----------
  const FOLDER_KEY = 'score-scroll-folder';
  let curFolder = 'all';   // 'all'（すべて）/ 'none'（未分類）/ フォルダのid
  try { curFolder = localStorage.getItem(FOLDER_KEY) || 'all'; } catch (e) {}
  function setFolder(id) {
    curFolder = id;
    try { localStorage.setItem(FOLDER_KEY, id); } catch (e) {}
    renderLibrary();
  }
  function byOrder(a, b) { return (a.order || 0) - (b.order || 0) || a.created - b.created; }

  // 下から出る選択メニュー
  function openSheet(title, items) {
    el.sheetTitle.textContent = title;
    el.sheetList.textContent = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'sheet-btn' + (it.danger ? ' danger' : '') + (it.current ? ' current' : '');
      b.textContent = it.label;
      b.addEventListener('click', () => { closeSheet(); if (it.run) it.run(); });
      el.sheetList.append(b);
    }
    const cancel = document.createElement('button');
    cancel.className = 'sheet-btn cancel'; cancel.textContent = 'キャンセル';
    cancel.addEventListener('click', closeSheet);
    el.sheetList.append(cancel);
    el.sheet.classList.remove('hidden');
  }
  function closeSheet() { el.sheet.classList.add('hidden'); }
  el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });

  async function createFolder() {
    const name = prompt('新しいフォルダの名前', '');
    if (!name || !name.trim()) return null;
    const list = await store.folders();
    const f = { id: 'f' + newId(), name: name.trim(), created: Date.now(), order: list.length };
    await store.putFolder(f);
    return f;
  }
  function editFolder(f) {
    openSheet('フォルダ「' + f.name + '」', [
      { label: '名前を変更', run: async () => {
        const name = prompt('フォルダの名前', f.name);
        if (name && name.trim()) { f.name = name.trim(); await store.putFolder(f); renderLibrary(); }
      } },
      { label: 'フォルダを削除', danger: true, run: async () => {
        if (confirm('フォルダ「' + f.name + '」を削除しますか？\n中の楽譜は消えずに「未分類」に移ります。')) {
          await store.removeFolder(f.id); setFolder('all'); toast('フォルダを削除しました');
        }
      } }
    ]);
  }
  async function moveScore(s) {
    const folders = (await store.folders()).sort(byOrder);
    const items = [{ label: '未分類', current: !s.folder, run: async () => { s.folder = null; await store.put(s); renderLibrary(); toast('「未分類」に移動しました'); } }];
    for (const f of folders) {
      items.push({ label: f.name, current: s.folder === f.id, run: async () => { s.folder = f.id; await store.put(s); renderLibrary(); toast('「' + f.name + '」に移動しました'); } });
    }
    items.push({ label: '＋ 新しいフォルダを作って移動', run: async () => {
      const f = await createFolder();
      if (f) { s.folder = f.id; await store.put(s); renderLibrary(); toast('「' + f.name + '」に移動しました'); }
    } });
    openSheet('「' + s.title + '」の移動先', items);
  }

  function chip(label, count, active, onClick, extraClass) {
    const b = document.createElement('button');
    b.className = 'chip' + (active ? ' active' : '') + (extraClass ? ' ' + extraClass : '');
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
    const t = document.createElement('span'); t.textContent = label; b.append(t);
    if (count != null) { const c = document.createElement('span'); c.className = 'chip-count'; c.textContent = count; b.append(c); }
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- 一覧 ----------
  let thumbUrls = [];
  async function renderLibrary() {
    thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    thumbUrls = [];
    const [all, folders] = await Promise.all([store.all(), store.folders()]);
    folders.sort(byOrder);
    const fmap = new Map(folders.map((f) => [f.id, f]));
    all.forEach((s) => { if (s.folder && !fmap.has(s.folder)) s.folder = null; });
    if (curFolder !== 'all' && curFolder !== 'none' && !fmap.has(curFolder)) curFolder = 'all';

    // フォルダのタブ
    el.folderBar.textContent = '';
    el.folderBar.append(chip('すべて', all.length, curFolder === 'all', () => setFolder('all')));
    for (const f of folders) {
      el.folderBar.append(chip(f.name, all.filter((s) => s.folder === f.id).length, curFolder === f.id, () => setFolder(f.id)));
    }
    const noneCount = all.filter((s) => !s.folder).length;
    if (folders.length) el.folderBar.append(chip('未分類', noneCount, curFolder === 'none', () => setFolder('none')));
    el.folderBar.append(chip('＋ フォルダ', null, false, async () => { const f = await createFolder(); if (f) setFolder(f.id); }, 'chip-add'));
    if (fmap.has(curFolder)) el.folderBar.append(chip('フォルダを編集', null, false, () => editFolder(fmap.get(curFolder)), 'chip-edit'));

    const list = all
      .filter((s) => curFolder === 'all' ? true : curFolder === 'none' ? !s.folder : s.folder === curFolder)
      .sort((a, b) => (b.opened || b.created) - (a.opened || a.created));
    el.grid.textContent = '';
    el.empty.classList.toggle('hidden', list.length > 0);
    el.emptyText.textContent = all.length === 0 ? 'まだ楽譜がありません。' : 'このフォルダにはまだ楽譜がありません。';
    for (const s of list) {
      const card = document.createElement('div');
      card.className = 'card';
      const open = document.createElement('button');
      open.className = 'card-open';
      open.setAttribute('aria-label', s.title + ' を開く');
      const img = document.createElement('img');
      img.className = 'thumb'; img.alt = '';
      store.getPage(s.id, 0).then((b) => { if (b) { const u = URL.createObjectURL(b); thumbUrls.push(u); img.src = u; } });
      const body = document.createElement('div');
      body.className = 'card-body';
      const t = document.createElement('div'); t.className = 'card-title'; t.textContent = s.title;
      const m = document.createElement('div'); m.className = 'card-meta';
      m.textContent = s.pageCount + 'ページ・速さ ' + s.speed + (curFolder === 'all' && s.folder ? '・' + fmap.get(s.folder).name : '');
      body.append(t, m);
      open.append(img, body);
      open.addEventListener('click', () => openScore(s.id));
      const acts = document.createElement('div'); acts.className = 'card-actions';
      const ren = document.createElement('button'); ren.className = 'mini'; ren.textContent = '名前';
      ren.setAttribute('aria-label', '「' + s.title + '」の名前を変更');
      ren.addEventListener('click', async () => {
        const name = prompt('楽譜の名前', s.title);
        if (name && name.trim()) { s.title = name.trim(); await store.put(s); renderLibrary(); }
      });
      const mv = document.createElement('button'); mv.className = 'mini'; mv.textContent = '移動';
      mv.setAttribute('aria-label', '「' + s.title + '」をフォルダへ移動');
      mv.addEventListener('click', () => moveScore(s));
      const del = document.createElement('button'); del.className = 'mini'; del.textContent = '削除';
      del.setAttribute('aria-label', '「' + s.title + '」を削除');
      del.addEventListener('click', async () => {
        if (confirm('「' + s.title + '」を削除しますか？')) { await store.remove(s); renderLibrary(); }
      });
      acts.append(ren, mv, del);
      card.append(open, acts);
      el.grid.append(card);
    }
  }

  // ---------- 楽譜画面と自動スクロール ----------
  let cur = null;          // 開いている楽譜
  let pageUrls = [];
  let playing = false;
  let counting = false;
  let pos = 0;             // スクロール位置（小数で保持）
  let lastT = 0;
  let touching = false;
  let lastUserScroll = 0;
  let ourScrollTop = -1;
  let countTimer = 0;
  let wakeLock = null;
  let pendingReload = false;

  // 速さ1〜60 → 1秒あたりのピクセル（表示幅に比例）
  function pxPerSec() {
    const w = el.pages.clientWidth || el.scroller.clientWidth;
    return cur.speed * 3 * (w / 1000);
  }
  function updateSpeedUI() {
    el.speed.value = cur.speed;
    el.speedVal.textContent = cur.speed;
    el.miniSpeed.textContent = '速さ ' + cur.speed;
    const imgs = el.pages.querySelectorAll('img');
    let h = 0, n = 0;
    imgs.forEach((im) => { if (im.offsetHeight) { h += im.offsetHeight; n++; } });
    if (n) {
      const sec = Math.round((h / n) / pxPerSec());
      el.perPage.textContent = '1ページ 約' + (sec >= 60 ? Math.floor(sec / 60) + '分' + (sec % 60 ? (sec % 60) + '秒' : '') : sec + '秒');
    }
  }
  let saveTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (cur) store.put(cur); }, 400);
  }
  function setSpeed(v) {
    cur.speed = Math.max(1, Math.min(60, Math.round(v)));
    updateSpeedUI();
    saveSoon();
  }
  function applyWidth() {
    el.pages.style.width = cur.width + '%';
    el.widthSel.value = String(cur.width);
    setTimeout(updateSpeedUI, 50);
  }

  async function openScore(id) {
    const s = await store.get(id);
    if (!s) return;
    cur = s;
    cur.opened = Date.now();
    store.put(cur);
    el.library.classList.add('hidden');
    el.viewer.classList.remove('hidden');
    el.title.textContent = s.title;
    el.countSel.value = String(s.countIn);
    el.pages.textContent = '';
    pageUrls.forEach((u) => URL.revokeObjectURL(u));
    pageUrls = [];
    applyWidth();
    const loads = [];
    for (let i = 0; i < s.pageCount; i++) {
      const img = document.createElement('img');
      img.alt = s.title + ' ' + (i + 1) + 'ページ';
      img.decoding = 'async';
      el.pages.append(img);
      loads.push(store.getPage(s.id, i).then((b) => {
        if (!b) return;
        const u = URL.createObjectURL(b); pageUrls.push(u);
        return new Promise((r) => { img.onload = r; img.onerror = r; img.src = u; });
      }));
    }
    await Promise.all(loads);
    updateSpeedUI();
    const max = el.scroller.scrollHeight - el.scroller.clientHeight;
    pos = Math.max(0, Math.min(max, (s.pos || 0) * el.scroller.scrollHeight));
    setScroll(pos);
    showControls();
  }

  function closeScore() {
    stop();
    if (cur) { cur.pos = el.scroller.scrollTop / Math.max(1, el.scroller.scrollHeight); store.put(cur); }
    el.viewer.classList.add('hidden');
    el.library.classList.remove('hidden');
    pageUrls.forEach((u) => URL.revokeObjectURL(u));
    pageUrls = [];
    el.pages.textContent = '';
    cur = null;
    if (pendingReload) { location.reload(); return; }
    renderLibrary();
  }

  function setScroll(y) {
    ourScrollTop = Math.round(y);
    el.scroller.scrollTop = y;
  }

  function setPlayingUI() {
    const on = playing || counting;
    el.icoPlay.classList.toggle('hidden', on);
    el.icoPause.classList.toggle('hidden', !on);
    el.playBtn.setAttribute('aria-label', on ? '一時停止' : 'スタート');
    el.mini.classList.toggle('hidden', !on);
    el.controls.classList.toggle('dim', on);
  }
  function showControls() { el.controls.classList.remove('dim'); }

  async function lockScreen() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  }
  function unlockScreen() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }

  function start() {
    if (!cur || playing || counting) return;
    const max = el.scroller.scrollHeight - el.scroller.clientHeight;
    if (el.scroller.scrollTop >= max - 2) { pos = 0; setScroll(0); }
    pos = el.scroller.scrollTop;
    lockScreen();
    const n = Number(cur.countIn) || 0;
    if (n > 0) {
      counting = true; setPlayingUI();
      let left = n;
      el.countNum.textContent = left;
      el.countdown.classList.remove('hidden');
      countTimer = setInterval(() => {
        left--;
        if (left <= 0) { clearInterval(countTimer); el.countdown.classList.add('hidden'); counting = false; begin(); }
        else el.countNum.textContent = left;
      }, 1000);
    } else begin();
  }
  function begin() {
    playing = true; setPlayingUI();
    pos = el.scroller.scrollTop;
    lastT = performance.now();
    requestAnimationFrame(tick);
  }
  function stop() {
    if (counting) { clearInterval(countTimer); counting = false; el.countdown.classList.add('hidden'); }
    playing = false;
    setPlayingUI();
    unlockScreen();
    if (cur) { cur.pos = el.scroller.scrollTop / Math.max(1, el.scroller.scrollHeight); saveSoon(); }
  }
  function toggle() { (playing || counting) ? stop() : start(); }

  function tick(t) {
    if (!playing) return;
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    const userActive = touching || (performance.now() - lastUserScroll < 450);
    if (userActive) {
      pos = el.scroller.scrollTop;
    } else {
      pos += pxPerSec() * dt;
      const max = el.scroller.scrollHeight - el.scroller.clientHeight;
      if (pos >= max) { pos = max; setScroll(pos); stop(); toast('最後まで来ました'); return; }
      setScroll(pos);
    }
    requestAnimationFrame(tick);
  }

  // 指でのスクロールを優先する
  el.scroller.addEventListener('scroll', () => {
    if (Math.abs(el.scroller.scrollTop - ourScrollTop) > 2) {
      lastUserScroll = performance.now();
      pos = el.scroller.scrollTop;
    }
  }, { passive: true });
  el.scroller.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  el.scroller.addEventListener('touchend', () => { touching = false; lastUserScroll = performance.now(); }, { passive: true });
  el.scroller.addEventListener('touchcancel', () => { touching = false; }, { passive: true });

  // 楽譜を軽くタップ → スタート／一時停止
  let down = null;
  el.scroller.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  el.scroller.addEventListener('pointercancel', () => { down = null; });
  el.scroller.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 350;
    down = null;
    if (moved < 10 && quick) {
      if (playing || counting) stop();
      else if (el.controls.classList.contains('dim')) showControls();
      else start();
    }
  });

  el.playBtn.addEventListener('click', toggle);
  el.mini.addEventListener('click', stop);
  el.topBtn.addEventListener('click', () => { stop(); pos = 0; el.scroller.scrollTo({ top: 0, behavior: 'smooth' }); });
  el.backBtn.addEventListener('click', closeScore);
  el.speed.addEventListener('input', () => setSpeed(Number(el.speed.value)));
  el.slower.addEventListener('click', () => setSpeed(cur.speed - 1));
  el.faster.addEventListener('click', () => setSpeed(cur.speed + 1));
  el.countSel.addEventListener('change', () => { cur.countIn = Number(el.countSel.value); saveSoon(); });
  el.widthSel.addEventListener('change', () => {
    const ratio = el.scroller.scrollTop / Math.max(1, el.scroller.scrollHeight);
    cur.width = Number(el.widthSel.value); applyWidth(); saveSoon();
    requestAnimationFrame(() => { pos = ratio * el.scroller.scrollHeight; setScroll(pos); });
  });

  // キーボード・譜めくりペダル
  document.addEventListener('keydown', (e) => {
    if (!cur || el.viewer.classList.contains('hidden')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT') { if (e.key !== ' ') return; }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSpeed(cur.speed + 1); toast('速さ ' + cur.speed); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSpeed(cur.speed - 1); toast('速さ ' + cur.speed); }
    else if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); pos = el.scroller.scrollTop + el.scroller.clientHeight * 0.8; setScroll(pos); lastUserScroll = performance.now(); }
    else if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); pos = Math.max(0, el.scroller.scrollTop - el.scroller.clientHeight * 0.8); setScroll(pos); lastUserScroll = performance.now(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && (playing || counting)) stop();
  });
  window.addEventListener('resize', () => { if (cur) updateSpeedUI(); });

  // ---------- 起動 ----------
  if ('serviceWorker' in navigator) {
    // 新しい版が届いたら、楽譜を表示していないときに自動で読み込み直す
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      if (cur) { toast('新しい版があります。一覧に戻ると切り替わります'); pendingReload = true; return; }
      reloaded = true; location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') navigator.serviceWorker.getRegistration().then((reg) => reg && reg.update()).catch(() => {});
    });
  }
  renderLibrary().catch((e) => { console.error(e); alert('保存領域を開けませんでした。プライベートブラウズでは使えません。'); });
})();
