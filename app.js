'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  // ---------- IndexedDB: звук и ключ ----------
  const DB = (() => {
    let p;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('glagoly', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('audio'); r.result.createObjectStore('meta'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (store, mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode); const req = fn(t.objectStore(store));
        t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
        t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    };
    return {
      put: (s, k, v) => tx(s, 'readwrite', st => st.put(v, k)),
      get: (s, k) => tx(s, 'readonly', st => st.get(k)),
      count: s => tx(s, 'readonly', st => st.count()),
      clear: s => tx(s, 'readwrite', st => st.clear()),
    };
  })();

  // ---------- настройки и память ----------
  // Режимы: listen — слушать (глагол целиком по кругу), repeat — повторять (пауза + запись голоса), recall — вспоминать (оценка каждой фразы)
  const S = Object.assign({ mode: 'recall', hand: 'left' }, LS.get('gl.set2', {}));
  if (S.hand !== 'right') S.hand = 'left';
  if (!['listen', 'repeat', 'recall'].includes(S.mode)) S.mode = 'recall';
  S.he = S.mode !== 'recall';                          // иврит скрыт только когда вспоминаешь
  const saveS = () => LS.set('gl.set2', { mode: S.mode, hand: S.hand });
  // память по ФРАЗАМ (ключ «номер#фраза»): s — подряд верных ответов (0 = не знаю), i — интервал в днях, ef — коэффициент, due — когда повторить
  let MEM = LS.get('gl.mem2', {});
  const saveM = () => LS.set('gl.mem2', MEM);
  const mk = (id, i) => id + '#' + i;
  const DAY = 86400000, MAX_DAYS = 180;                // расписание в духе SM-2: 1, 6 дней, дальше × коэффициент (2,5 → подстраивается)
  const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  let SESSION = null;                                  // идёт занятие «Заниматься»

  let DATA = null, BYID = {}, LIST = [];
  const A = $('#a'); A.preservesPitch = true;

  // ---------- расшифровка данных ----------
  async function decryptWith(b64) {
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const buf = new Uint8Array(await (await fetch('data.enc')).arrayBuffer());
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---------- импорт файла со звуком ----------
  async function importPack(file, onProg) {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (String.fromCharCode(...head.slice(0, 4)) !== 'GLG1') throw new Error('Это не тот файл: нужен glagoly-audio.glg');
    const hl = new DataView(head.buffer).getUint32(4, true);
    const hdr = JSON.parse(new TextDecoder().decode(await file.slice(8, 8 + hl).arrayBuffer()));
    try { await decryptWith(hdr.key); } catch { throw new Error('Файл не подходит к этой версии приложения'); }
    const base = 8 + hl;
    for (let i = 0; i < hdr.files.length; i++) {
      const f = hdr.files[i];
      const ab = await file.slice(base + f.off, base + f.off + f.len).arrayBuffer();
      await DB.put('audio', f.id, new Blob([ab], { type: 'audio/mpeg' }));
      onProg && onProg(i + 1, hdr.files.length);
    }
    await DB.put('meta', 'key', hdr.key);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ок */ }
  }

  // ---------- экран первой настройки ----------
  function renderSetup(msg) {
    $('#app').innerHTML = `<div class="wrap"><div class="top"><h1>Глаголы иврита</h1><div class="sub">Первый запуск</div></div>
      <div class="card"><h3>Загрузите звук</h3>
      <p class="note">Выберите файл <b>glagoly-audio.glg</b> (из OneDrive или «Файлов»). Звук скопируется в память приложения один раз, потом всё работает без интернета.</p>
      <label class="btn" for="pick">Выбрать файл</label><input id="pick" type="file" style="position:absolute;left:-9999px">
      <div class="progress"><i id="pb"></i></div><div id="pt" class="note" style="margin-top:8px"></div>
      <div id="pe" class="err">${esc(msg || '')}</div></div></div>`;
    $('#pick').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      $('#pe').textContent = '';
      try {
        await importPack(f, (i, n) => { $('#pb').style.width = (100 * i / n) + '%'; $('#pt').textContent = `Копирую звук: ${i} из ${n}`; });
        DATA = await decryptWith(await DB.get('meta', 'key')); start();
      } catch (err) { $('#pe').textContent = err.message || String(err); }
    });
  }

  // ---------- состояние памяти глагола (по его фразам) ----------
  const grpText = f => esc(f).replace(/[א-ת]+(?:[ ,]+[א-ת]+)*/g, m => `<bdi dir="ltr" lang="he">${m}</bdi>`);
  const pastForm = v => v.title.split(/\s[—–-]\s/)[0];
  function verbStats(v) {
    const now = Date.now(); let started = 0, due = 0, forgot = 0, weak = false;
    v.items.forEach((_, i) => {
      const m = MEM[mk(v.id, i)]; if (!m) return;
      started++; if (m.s === 0) forgot++; if (m.due <= now) due++; if ((m.i || 0) < 30) weak = true;
    });
    return { started, due, forgot, total: v.items.length, weak };
  }
  function memState(v) {
    const st = verbStats(v); if (!st.started) return '';
    if (st.forgot) return 'forgot'; if (st.due) return 'due';
    return st.started < st.total || st.weak ? 'learning' : 'strong';
  }
  const duePhrases = () => LIST.reduce((n, v) => n + verbStats(v).due, 0);
  // новое вводится осторожно: один новый глагол в день, и ни одного, пока накопилась задолженность — просроченные (раньше сегодняшнего дня) фразы
  const NEW_PER_DAY = 1, BRAKE = 30;
  const overdue = () => { const day = startOfDay(Date.now()); return Object.values(MEM).filter(m => m.due < day).length; };
  const rated = v => v.items.some((_, i) => MEM[mk(v.id, i)]), unrated = v => v.items.some((_, i) => !MEM[mk(v.id, i)]);
  const newToday = () => { const r = LS.get('gl.newday', null); return r && r.d === startOfDay(Date.now()) ? r.ids : []; };
  const noteNew = id => { const ids = newToday(); if (!ids.includes(id)) LS.set('gl.newday', { d: startOfDay(Date.now()), ids: [...ids, id] }); };
  const byFreq = (a, b) => (a.fr ?? 999) - (b.fr ?? 999) || a.num - b.num;
  function freshCandidates(seen) {
    const today = newToday();
    const going = LIST.filter(v => !seen.has(v.id) && unrated(v) && (rated(v) || today.includes(v.id))).sort(byFreq);   // начатое сегодня или раньше — продолжаем без лимита
    if (going.length) return going;
    if (today.length >= NEW_PER_DAY || overdue() > BRAKE) return [];                                                     // дневной лимит или задолженность по повторениям
    return LIST.filter(v => !seen.has(v.id) && !rated(v)).sort(byFreq).slice(0, 1);
  }
  const hasFresh = () => freshCandidates(new Set()).length > 0;

  // ---------- главный экран ----------
  function renderHome() {
    const due = duePhrases(), fresh = hasFresh();
    const tip = due ? `повторить фраз: ${due}${fresh ? ' · потом новые' : ''}` : (fresh ? 'повторять пока нечего · новые глаголы' : 'на сегодня всё');
    peekId = pickVerb(new Set());                           // глагол, на который попадёшь по «Заниматься»: по его биньяну красим кнопки
    const pb = peekId ? BYID[peekId].b : null;
    $('#app').innerHTML = `<div class="wrap"><div class="top"><div class="trow"><div><h1>Глаголы иврита</h1>
      <div class="sub">${LIST.length} глаголов</div></div>
      <div class="tools"${pb !== null ? ` data-b="${pb}"` : ''}><button class="link go" id="cont" title="${esc(tip)}">Заниматься</button><button class="link" id="exp">Сохранить прогресс</button><button class="link" id="imp">Загрузить прогресс</button>
      <input id="impf" type="file" accept=".json,application/json" style="display:none"></div></div>
      <input class="search" id="q" type="search" placeholder="Поиск: иврит или русский" autocomplete="off"></div>
      <div id="list"></div><div class="foot"></div></div>`;
    $('#q').addEventListener('input', e => renderList(e.target.value));
    $('#cont').addEventListener('click', startSession);
    $('#exp').addEventListener('click', exportProgress);
    $('#imp').addEventListener('click', () => $('#impf').click());
    $('#impf').addEventListener('change', importProgress);
    renderList('');
  }

  // клетки памяти одного биньяна: цвет — биньян, вид клетки — состояние памяти
  function cellsHTML(bi) {
    return LIST.filter(v => v.b === bi).map(v => { const ms = memState(v); return `<button class="mc"${ms ? ` data-m="${ms}"` : ''} data-id="${v.id}" title="${esc(pastForm(v))} — ${esc(v.ru)}" aria-label="${esc(v.ru)}"></button>`; }).join('');
  }

  function renderList(q) {
    q = (q || '').trim().toLowerCase();
    const searching = q.length > 0;
    let html = '';
    DATA.binyan.forEach((b, bi) => {
      const vs = LIST.filter(v => v.b === bi && (!searching || v.title.toLowerCase().includes(q) || v.ru.toLowerCase().includes(q)));
      if (!vs.length) return;
      html += `<details class="sec" data-b="${bi}"${searching ? ' open' : ''}><summary><span class="sec-t"><span class="sec-he" lang="he">${esc(b.he)}</span><i class="dot"></i><b>${esc(b.ru)}</b></span><div class="cells">${cellsHTML(bi)}</div></summary>
        <div class="tiles">`;
      vs.forEach(v => {
        if (v.g && v.g.f && !searching) html += `<div class="grp">${grpText(v.g.f)}</div>`;
        const ms = memState(v);
        html += `<button class="row" data-id="${v.id}"${ms ? ` data-m="${ms}"` : ''}><span class="rt"><span class="he" lang="he">${esc(pastForm(v))}</span><i class="sep"></i><span class="ru">${esc(v.ru)}</span></span><span class="st">${ms ? '<i class="md"></i>' : ''}</span></button>`;
      });
      html += '</div></details>';
    });
    $('#list').innerHTML = html || '<p class="note" style="padding:16px">Ничего не найдено</p>';
    $('#list').querySelectorAll('.row').forEach(r => r.addEventListener('click', () => openPlayer(r.dataset.id)));
    $('#list').onclick = e => { const c = e.target.closest('.mc'); if (c) { e.preventDefault(); openPlayer(c.dataset.id); } };   // клетка в заголовке не сворачивает блок
  }

  function exportProgress() {
    const blob = new Blob([JSON.stringify({ mem2: MEM, mode: S.mode }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'glagoly-progress.json';
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function importProgress(e) {
    const f = e.target.files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); if (!j.mem2) throw new Error('нет данных'); MEM = j.mem2; saveM(); renderHome(); } catch { alert('Не удалось прочитать файл прогресса'); }
  }

  // ---------- подсветка глагола ----------
  const FIN = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  const isHe = ch => ch >= 'א' && ch <= 'ת';
  function markWord(tok, stem, sx, gh) {
    const chars = [...tok], idx = [];
    chars.forEach((c, i) => { if (isHe(c)) idx.push(i); });
    const n = idx.length;
    if (n < stem.length || n > stem.length + 5) return null;
    const pos = []; let si = 0;
    for (let k = 0; k < n && si < stem.length; k++) {
      const c = chars[idx[k]]; if ((FIN[c] || c) === stem[si]) { pos.push(k); si++; }
    }
    if (si < stem.length) return null;
    if (pos[0] > 3 || n - 1 - pos[pos.length - 1] > 3) return null;
    for (let i = 1; i < pos.length; i++) {
      const gap = pos[i] - pos[i - 1];
      if (gap > (stem.length === 2 ? 1 : 2)) { let ok = gap <= 4; for (let k = pos[i - 1] + 1; k < pos[i]; k++) { const c = chars[idx[k]]; if (c !== 'י' && c !== 'ו') ok = false; } if (!ok) return null; }
    }
    const rootAt = new Set(pos.map(k => idx[k]));
    const spAt = new Set((sx || []).filter(k => pos[k] !== undefined).map(k => idx[pos[k]]));      // особая буква корня этой группы
    let ghHere = -1;                                                                               // выпадающая буква, если она на месте: она тоже часть корня
    if (gh && stem.length === 2) {
      const first = idx[pos[0]];
      for (let b = first - 1; b >= Math.max(0, first - 3); b--) if ((FIN[chars[b]] || chars[b]) === gh) { ghHere = b; break; }
    }
    return chars.map((c, i) => (isHe(c) ? `<span class="${spAt.has(i) ? 'sp' : (rootAt.has(i) || i === ghHere) ? 'r' : 'a'}">${esc(c)}</span>` : esc(c))).join('');
  }
  let STOP = new Set();
  const tidy = s => s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');          // лишние пробелы внутри скобок дают некрасивый перенос
  function hebHTML(text, stem, fm, sx, gh) {
    return tidy(text).split(/(\s+)/).map(tok => {
      if (!stem || !tok.trim()) return esc(tok);
      const letters = [...tok].filter(isHe).join('');
      if (stem.length <= 2 && STOP.has(letters) && !(fm && fm.includes(letters))) return esc(tok);   // короткая основа: отсекаем служебные слова
      const lead = tok.match(/^[^א-ת]*/)[0], trail = tok.slice(lead.length).match(/[^א-ת]*$/)[0];
      const core = tok.slice(lead.length, tok.length - trail.length);
      const m = core ? markWord(core, stem, sx, gh) : null;
      return m ? `${esc(lead)}<span class="vb">${m}</span>${esc(trail)}` : esc(tok);
    }).join('');
  }

  // ---------- плеер ----------
  // cur: {id, v, order: [номера фраз этого прохода], pos: позиция в order, idx: текущая фраза}
  let cur = null, curUrl = null, playing = false, waiting = false, gapTimer = null, endTimer = null, raf = 0, activeIdx = -1;

  const svg = (d, stroke) => `<svg viewBox="0 0 24 24" aria-hidden="true" ${stroke ? 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"' : 'fill="currentColor"'}><path d="${d}"/></svg>`;
  const IC = {
    play: svg('M8 5.5v13l11-6.5z'), pause: svg('M7 5h3.6v14H7zM13.4 5H17v14h-3.6z'),
    pv: svg('M6 5h2.2v14H6zM19 5.5v13l-9.5-6.5z'), nv: svg('M15.8 5H18v14h-2.2zM5 5.5v13l9.5-6.5z'),
    ps: svg('M14.5 6l-6 6 6 6', true), ns: svg('M9.5 6l6 6-6 6', true), back: svg('M14.5 5.5l-6.5 6.5 6.5 6.5', true),
  };
  const MODES = [['listen', 'Слушать'], ['repeat', 'Повторять'], ['recall', 'Вспоминать']];

  function buildPlayer() {
    const p = document.createElement('section'); p.id = 'player';
    p.innerHTML = `<div class="p-head"><button class="ic" id="pBack" aria-label="Назад" title="К списку (Esc)">${IC.back}</button>
      <div class="p-title"><div class="vt"><span class="hw" id="pHW" lang="he"></span><span class="ru" id="pRU"></span><span class="gd" id="pGD"></span></div></div><span></span></div>
      <div class="p-list" id="pL"></div>
      <div class="p-ctl"><div class="p-info" id="pI"></div>
      <div class="p-main"><button id="bPV" aria-label="Предыдущий глагол" title="Предыдущий глагол (Q)">${IC.pv}</button><button id="bPS" aria-label="Предыдущая фраза" title="Предыдущая фраза (A)">${IC.ps}</button>
        <button class="play" id="bP" aria-label="Играть" title="Играть / пауза (Пробел)">${IC.play}</button><button id="bNS" aria-label="Следующая фраза" title="Следующая фраза (D)">${IC.ns}</button><button id="bNV" aria-label="Следующий глагол" title="Следующий глагол (E)">${IC.nv}</button></div>
      <div class="rate"><button data-r="no" title="Не знаю (Z)">Не знаю</button><button data-r="doubt" title="Сомневаюсь (X)">Сомневаюсь</button><button data-r="yes" title="Знаю (C)">Знаю</button></div>
      <div class="chips" id="cMode"><span class="lab">Режим</span></div>
      <div class="keys" id="keys"></div></div>`;
    document.body.appendChild(p);
    renderKeys();
    MODES.forEach(([k, label]) => {
      const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.dataset.mode = k;
      b.addEventListener('click', () => setMode(k)); $('#cMode').appendChild(b);
    });
    $('#pBack').addEventListener('click', closePlayer);
    $('#bP').addEventListener('click', togglePlay);
    $('#bNS').addEventListener('click', () => stepPhrase(1));
    $('#bPS').addEventListener('click', () => stepPhrase(-1));
    $('#bNV').addEventListener('click', () => stepVerb(1));
    $('#bPV').addEventListener('click', () => stepVerb(-1));
    $('.rate').querySelectorAll('button').forEach(b => b.addEventListener('click', () => rate(b.dataset.r)));
    syncChips();
  }

  function syncChips() {
    document.body.classList.toggle('hide-he', !S.he);
    document.querySelectorAll('#cMode .chip').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode)));
    const pl = $('#player'); if (pl) pl.dataset.mode = S.mode;
  }
  function warn(msg) { const el = $('#pI'); if (!el) return; el.textContent = msg || ''; el.classList.toggle('show', !!msg); }
  function setUI() { const b = $('#bP'); if (b) { b.innerHTML = playing ? IC.pause : IC.play; b.setAttribute('aria-label', playing ? 'Пауза' : 'Играть'); } }

  async function openPlayer(id) {
    if (!$('#player')) buildPlayer();
    $('#player').classList.add('open');
    await load(id);
  }
  function closePlayer() {
    SESSION = null; pausePlay(); micRelease(); $('#player').classList.remove('open'); renderHome();
  }

  // ---------- проход по фразам глагола ----------
  const activeIdxs = v => v.items.map((_, i) => i).filter(i => { const m = MEM[mk(v.id, i)]; return !m || m.due <= Date.now(); });

  async function load(id) {
    stopGap(); clearTimeout(endTimer); cancelAnimationFrame(raf); A.pause(); playing = false;
    const v = BYID[id];
    let order = SESSION ? activeIdxs(v) : v.items.map((_, i) => i);
    if (!order.length) order = v.items.map((_, i) => i);
    cur = { id, v, order, pos: 0, idx: order[0] };
    S.he = S.mode !== 'recall';
    LS.set('gl.last', id);
    $('#pHW').textContent = pastForm(v); $('#pRU').textContent = v.ru; $('#pGD').innerHTML = `<span class="bh" lang="he">${esc(DATA.binyan[v.b].he)}</span>` + (v.gc ? ' — ' + grpText(v.gc) : '');
    $('#player').dataset.b = v.b;
    const inOrder = new Set(order);
    $('#pL').innerHTML = v.items.map((it, i) => `<div class="s${inOrder.has(i) ? '' : ' skip'}" data-i="${i}" tabindex="0" role="button">
      <div class="c he" lang="he">${it[4] ? '<span class="q"><span class="flag" title="Сомнительная привязка текста к звуку">⚠</span></span>' : ''}<span class="t">${hebHTML(it[0], v.st, v.fm, v.sx, v.gh)}</span></div>
      <div class="mid"><i></i></div>
      <div class="c ru"><span class="t">${esc(tidy(it[1]))}</span></div>
      <div class="prog"><i></i></div></div>`).join('');
    $('#pL').querySelectorAll('.s').forEach(s => s.addEventListener('click', () => pickPhrase(+s.dataset.i)));
    if (v.rl && v.rl.length) {
      $('#pL').insertAdjacentHTML('beforeend', `<details class="roots"><summary>Из того же корня</summary><div class="rchips">${v.rl.map(rid => { const w = BYID[rid]; return `<button class="rc" data-id="${rid}"><span lang="he">${esc(pastForm(w))}</span><small>${esc(w.ru)}</small></button>`; }).join('')}</div></details>`);
      $('#pL .rchips').addEventListener('click', e => { const b = e.target.closest('.rc'); if (b) { SESSION = null; openPlayer(b.dataset.id); } });
    }
    activeIdx = -1; syncChips(); setCur(0); $('#pL').scrollTop = 0; setUI(); warn('');
    const blob = await DB.get('audio', id);
    if (!blob) { warn('Нет звука для этого глагола'); return; }
    if (curUrl) URL.revokeObjectURL(curUrl);
    curUrl = URL.createObjectURL(blob); A.src = curUrl; A.playbackRate = 1;
    await new Promise(res => { A.addEventListener('loadedmetadata', res, { once: true }); setTimeout(res, 1500); });
    mediaSession();
  }

  function mediaSession() {
    if (!('mediaSession' in navigator) || !cur) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: cur.v.ru, artist: 'Глаголы иврита', album: DATA.binyan[cur.v.b].ru });
      navigator.mediaSession.setActionHandler('play', () => doPlay());
      navigator.mediaSession.setActionHandler('pause', () => pausePlay());
      navigator.mediaSession.setActionHandler('nexttrack', () => stepVerb(1));
      navigator.mediaSession.setActionHandler('previoustrack', () => stepVerb(-1));
    } catch { /* не поддерживается */ }
  }

  function setActive(i) {
    if (i === activeIdx) return; activeIdx = i;
    const items = $('#pL').querySelectorAll('.s');
    items.forEach((s, k) => { s.classList.toggle('on', k === i); if (k !== i) { const pi = s.querySelector('.prog i'); if (pi) pi.style.width = '0'; } });
    if (items[i]) items[i].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  const card = i => $('#pL').querySelectorAll('.s')[i];
  function setCur(pos) { cur.pos = pos; cur.idx = cur.order[pos]; setActive(cur.idx); }
  function progress(t) {
    const it = cur && cur.v.items[cur.idx]; const el = $('#pL .s.on .prog i'); if (!it || !el) return;
    el.style.width = Math.max(0, Math.min(100, 100 * (t - it[2]) / Math.max(0.2, it[3] - it[2]))) + '%';
  }
  const findIdx = t => { const it = cur.v.items; let k = 0; for (let i = 0; i < it.length; i++) if (it[i][2] <= t + 0.05) k = i; return k; };

  // ---------- воспроизведение ----------
  function seekPhrase(i) { A.currentTime = Math.max(0, cur.v.items[i][2] - 0.04); }

  async function doPlay() {
    if (!cur) return;
    if (wantRec() && !mic) await micEnsure();                // запрос микрофона по нажатию ▶: ждём ответ, чтобы первая пауза уже писалась
    if (S.mode === 'listen') {
      A.playbackRate = 1;
      try { await A.play(); } catch { warn('Нажмите ▶, чтобы начать'); return; }
      warn(''); playing = true; setUI(); loopTick(); return;
    }
    // повторять / вспоминать: играем фразу целиком и останавливаемся (повторять — дальше пауза и следующая)
    await playPhrase();
  }
  async function playPhrase() {
    stopGap(); clearTimeout(endTimer);
    const i = cur.idx, it = cur.v.items[i]; seekPhrase(i); A.playbackRate = 1;
    if (S.mode === 'recall') { const c = card(i); if (c) c.classList.add('rev'); }     // сыграли фразу — иврит этой фразы открывается
    try { await A.play(); } catch { warn('Нажмите ▶, чтобы начать'); return; }
    warn(''); playing = true; setUI(); loopTick(); armEnd(it);
  }
  function armEnd(it) {
    clearTimeout(endTimer);
    if (!cur || !playing || waiting || S.mode === 'listen') return;
    const ms = Math.max(15, (it[3] + 0.01 - A.currentTime) * 1000);
    endTimer = setTimeout(() => {
      if (!playing || waiting || S.mode === 'listen') return;
      if (A.currentTime >= it[3]) onPhraseEnd(); else armEnd(it);
    }, ms);
  }
  function onPhraseEnd() {
    if (S.mode === 'recall') { stopPlaying(); return; }                    // фраза сыграна: стоп, дальше оценка
    if (S.mode === 'repeat') startGap();
  }
  function stopPlaying() { clearTimeout(endTimer); A.pause(); playing = false; setUI(); cancelAnimationFrame(raf); const it = cur && cur.v.items[cur.idx]; if (it) progress(it[3]); }
  function pausePlay() { stopGap(); stopPlaying(); }
  function togglePlay() { playing || waiting ? pausePlay() : doPlay(); }

  // подсветка и полоска прогресса (только отображение; остановки идут по таймерам)
  function loopTick() {
    cancelAnimationFrame(raf);
    const f = () => {
      if (!playing || !cur) return;
      const t = A.currentTime;
      if (S.mode === 'listen') { const k = findIdx(t); if (k !== cur.idx) { cur.idx = k; setActive(k); } }
      if (!waiting) progress(t);
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
  }
  A.addEventListener('ended', () => {
    if (!cur) return;
    if (S.mode === 'listen') { A.currentTime = 0; A.play().catch(() => {}); }   // слушать: по кругу без конца
    else if (!waiting) onPhraseEnd();
  });

  // ---------- запись голоса в паузе («Повторять») ----------
  // Пока ты повторяешь фразу, микрофон пишет; затем звучит твоя запись и оригинал. Запись нигде не хранится.
  let mic = null, micFailed = false, gapSeq = 0, recAudio = null, recUrl = null, recorder = null, recSrc = null, actx = null, lastGain = 1;
  const wantRec = () => S.mode === 'repeat' && !micFailed && typeof MediaRecorder !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  async function micEnsure() {
    if (mic || !wantRec()) return !!mic;
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); return true; }
    catch { micFailed = true; mic = null; warn('Нет доступа к микрофону: пауза без записи'); return false; }
  }
  function micRelease() { recAbort(); if (mic) { mic.getTracks().forEach(tr => tr.stop()); mic = null; } }
  function recStart() {
    if (!mic) return null;
    const chunks = [];
    try { recorder = new MediaRecorder(mic); } catch { recorder = null; return null; }
    const rc = recorder;
    rc.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(res => { rc.onstop = () => res(new Blob(chunks, { type: rc.mimeType || 'audio/webm' })); });
    rc.start();
    return done;
  }
  function recAbort() {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* уже остановлен */ }
    recorder = null;
    if (recAudio) { try { recAudio.pause(); } catch { /* ок */ } recAudio = null; }
    if (recSrc) { try { recSrc.stop(); } catch { /* ок */ } recSrc = null; }
    if (recUrl) { URL.revokeObjectURL(recUrl); recUrl = null; }
  }
  // запись проигрываем с выравниванием: самый громкий момент поднимаем до 0,9 (усиление не больше 10×), чтобы тихий микрофон не мешал
  async function playLeveled(blob, maxMs) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') await actx.resume();
      const buf = await actx.decodeAudioData(await blob.arrayBuffer());
      let peak = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let n = 0; n < d.length; n++) { const a = Math.abs(d[n]); if (a > peak) peak = a; } }
      lastGain = Math.min(10, 0.9 / Math.max(peak, 0.01));
      const src = actx.createBufferSource(), g = actx.createGain();
      src.buffer = buf; g.gain.value = lastGain; src.connect(g); g.connect(actx.destination); recSrc = src;
      await new Promise(res => { src.onended = res; src.start(); setTimeout(res, maxMs); });
      recSrc = null; return true;
    } catch { return false; }                                                       // формат не раскодировался — запасной путь ниже
  }
  async function playBack(blob, it, seq, maxMs) {
    if (!(await playLeveled(blob, maxMs))) {
      recUrl = URL.createObjectURL(blob);
      const a = new Audio(recUrl); recAudio = a;
      await new Promise(res => { a.onended = res; a.onerror = res; a.play().catch(res); setTimeout(res, maxMs); });
      if (seq !== gapSeq) return;
      recAudio = null; URL.revokeObjectURL(recUrl); recUrl = null;
    }
    if (seq !== gapSeq) return;                                                      // запись больше не нужна, нигде не хранится
    A.currentTime = Math.max(0, it[2] - 0.04);                                     // и сразу оригинал для сравнения
    try { await A.play(); } catch { return; }
    const iv = setInterval(() => { if (seq === gapSeq) progress(A.currentTime); }, 50);
    await sleep(Math.max(100, (it[3] + 0.02 - A.currentTime) * 1000));
    clearInterval(iv);
    if (seq === gapSeq) A.pause();
  }

  function gapBarStart(sec, rec) {
    const p = $('#pL .s.on .prog'); if (!p) return;
    const i = p.firstElementChild;
    p.classList.add('run'); p.classList.toggle('rec', !!rec); i.classList.toggle('rec', !!rec);
    i.style.transition = 'none'; i.style.width = '0%'; void i.offsetWidth;
    i.style.transition = `width ${sec}s linear`; i.style.width = '100%';
  }
  function gapBarReset() {
    document.querySelectorAll('#pL .s .prog').forEach(p => {
      p.classList.remove('run', 'rec'); const i = p.firstElementChild;
      i.classList.remove('rec'); i.style.transition = 'none'; i.style.width = '0%';
    });
  }

  function startGap() {
    const it = cur.v.items[cur.idx]; clearTimeout(endTimer);
    waiting = true; A.pause();
    const sec = Math.max(1.4, (it[3] - it[2]) + 0.8);                          // длина фразы + запас на реакцию
    const seq = ++gapSeq, rec = wantRec() && mic ? recStart() : null;
    gapBarStart(sec, rec);
    gapTimer = setTimeout(async () => {
      gapBarReset();
      if (rec) {
        try { recorder.stop(); } catch { /* уже остановлен */ }
        const blob = await Promise.race([rec, sleep(1500).then(() => null)]);
        if (seq !== gapSeq) return;
        if (blob && blob.size > 200) await playBack(blob, it, seq, (sec + 3) * 1000);
        if (seq !== gapSeq) return;
      }
      waiting = false; nextInOrder();
    }, sec * 1000);
  }
  function stopGap() {
    const was = waiting; gapSeq++; clearTimeout(gapTimer); recAbort(); waiting = false;
    gapBarReset();
    if (was) A.pause();
  }
  function nextInOrder() {
    if (cur.pos + 1 < cur.order.length) { setCur(cur.pos + 1); playPhrase(); }
    else { stopPlaying(); }                                                      // повторять: после последней фразы остановка
  }

  // ---------- выбор фразы, режимы, глаголы ----------
  function pickPhrase(i) {
    if (!cur) return;
    stopGap();
    if (S.mode === 'listen') { cur.idx = i; setActive(i); seekPhrase(i); if (playing) A.play().catch(() => {}); else doPlay(); return; }
    let pos = cur.order.indexOf(i);
    if (pos < 0) { cur.order.splice(cur.pos + 1, 0, i); pos = cur.pos + 1; }      // фраза вне очереди: сыграем её сейчас
    setCur(pos); playPhrase();
  }
  function stepPhrase(d) {
    if (!cur) return;
    if (S.mode === 'listen') {
      const k = Math.max(0, Math.min(cur.v.items.length - 1, cur.idx + d)); cur.idx = k; setActive(k); seekPhrase(k); return;
    }
    const was = playing || waiting; pausePlay();
    const pos = Math.max(0, Math.min(cur.order.length - 1, cur.pos + d)); setCur(pos);
    if (was && S.mode === 'repeat') playPhrase();                                // в «Вспоминать» шаг не запускает звук: сначала вспомни
  }
  function setMode(m) {
    if (S.mode === m) return;
    const wasPlaying = playing || waiting; pausePlay();
    S.mode = m; saveS(); S.he = m !== 'recall';
    if (m === 'repeat') micEnsure(); else micRelease();
    syncChips();
    if (wasPlaying && m !== 'recall') doPlay();
  }
  function stepVerb(d) {
    if (!cur) return;
    if (SESSION) {
      if (d > 0) nextInSession();
      else if (SESSION.hist.length) { const keep = SESSION; openPlayer(SESSION.hist.pop()); SESSION = keep; }
      return;
    }
    const i = LIST.findIndex(v => v.id === cur.id), n = LIST[i + d];
    if (n) { const was = playing; pausePlay(); load(n.id).then(() => { if (was && S.mode !== 'recall') doPlay(); }); }
    else warn('Это край списка');
  }

  // ---------- оценка фразы и занятие ----------
  function rate(kind) {
    if (!cur || S.mode !== 'recall') return;
    const i = cur.idx, key = mk(cur.id, i), now = Date.now(), m = MEM[key] || { s: 0, i: 0, ef: 2.5 };
    if (m.ef === undefined) m.ef = 2.5;
    if (m.i === undefined) m.i = 0;
    if (kind === 'yes') {
      m.s = (m.s || 0) + 1;
      m.i = m.s === 1 ? 1 : m.s === 2 ? 6 : Math.min(MAX_DAYS, Math.round(m.i * m.ef));
      m.ef = Math.min(2.5, m.ef + 0.05);                       // легко даётся → интервалы растут быстрее
      m.due = startOfDay(now) + m.i * DAY;
    } else if (kind === 'doubt') {
      m.ef = Math.max(1.3, m.ef - 0.15); m.i = Math.max(1, Math.round(m.i * 0.5)); m.s = Math.max(1, m.s || 1);
      m.due = startOfDay(now) + DAY;                           // завтра
    } else {
      m.s = 0; m.i = 0; m.ef = Math.max(1.3, m.ef - 0.2);      // забыл: сначала, фраза считается трудной
      m.due = now;
    }
    m.last = now; MEM[key] = m; saveM();
    const c = card(i); if (c) c.dataset.r = kind;
    pausePlay();
    if (kind === 'no') cur.order.splice(Math.min(cur.order.length, cur.pos + 4), 0, i);   // «не знаю» вернётся в этом же проходе через несколько фраз
    if (cur.pos + 1 < cur.order.length) setCur(cur.pos + 1);
    else verbDone();
  }
  function verbDone() { if (SESSION) nextInSession(); else closePlayer(); }

  let peekId = null;
  function pickVerb(seen) {
    const now = Date.now();
    const dues = LIST.filter(v => !seen.has(v.id) && v.items.some((_, i) => { const m = MEM[mk(v.id, i)]; return m && m.due <= now; }));
    if (dues.length) return dues[Math.floor(Math.random() * dues.length)].id;       // сначала повторения, вперемешку
    const fresh = freshCandidates(seen)[0];                                            // потом новые: по частоте употребления, в рамках дневного лимита
    return fresh ? fresh.id : null;
  }
  function startSession() { S.mode = 'recall'; saveS(); SESSION = { seen: new Set(), hist: [] }; nextInSession(true); }
  function nextInSession(first) {
    if (cur && !first) SESSION.hist.push(cur.id);
    const id = first && peekId && !SESSION.seen.has(peekId) ? peekId : pickVerb(SESSION.seen);   // первый глагол — тот, чьим цветом была кнопка
    if (!id) { closePlayer(); return; }
    SESSION.seen.add(id);
    if (!rated(BYID[id])) noteNew(id);                                                  // глагол без единой оценки — это новый на сегодня
    openPlayer(id);
  }

  // ---------- клавиши: две раскладки (левая и правая рука) ----------
  // e.code — физическая клавиша, поэтому работают и на русской раскладке
  const LAYOUTS = {
    left:  { prev: 'KeyA', next: 'KeyD', pv: 'KeyQ', nv: 'KeyE', m1: 'Digit1', m2: 'Digit2', m3: 'Digit3', no: 'KeyZ', doubt: 'KeyX', yes: 'KeyC', back: 'Escape', find: 'KeyF',
             lab: { prev: 'A', next: 'D', pv: 'Q', nv: 'E', m1: '1', m2: '2', m3: '3', no: 'Z', doubt: 'X', yes: 'C', back: 'Esc' } },
    right: { prev: 'KeyJ', next: 'KeyL', pv: 'KeyU', nv: 'KeyO', m1: 'Digit7', m2: 'Digit8', m3: 'Digit9', no: 'KeyM', doubt: 'Comma', yes: 'Period', back: 'Backspace', find: 'KeyK',
             lab: { prev: 'J', next: 'L', pv: 'U', nv: 'O', m1: '7', m2: '8', m3: '9', no: 'M', doubt: ',', yes: '.', back: '⌫' } },
  };
  function renderKeys() {
    const box = $('#keys'); if (!box) return;
    const L = LAYOUTS[S.hand].lab, kb = (...n) => n.map(x => `<kbd>${esc(L[x] || x)}</kbd>`).join('');
    box.innerHTML = `<div class="kt">Горячие клавиши</div>
      <div class="hand"><button data-h="left" aria-pressed="${S.hand === 'left'}">Левая рука</button><button data-h="right" aria-pressed="${S.hand === 'right'}">Правая рука</button></div>
      <div class="kg"><div class="kr"><span class="kk"><kbd>Space</kbd></span><span>пуск / пауза</span></div></div>
      <div class="kg"><div class="kr"><span class="kk">${kb('prev', 'next')}</span><span>фраза назад / вперёд</span></div>
        <div class="kr"><span class="kk">${kb('pv', 'nv')}</span><span>глагол назад / вперёд</span></div>
        <div class="kr"><span class="kk">${kb('back')}</span><span>к списку</span></div></div>
      <div class="kg"><div class="kr"><span class="kk">${kb('m1', 'm2', 'm3')}</span><span>слушать · повторять · вспоминать</span></div></div>
      <div class="kg"><div class="kr"><span class="kk">${kb('no', 'doubt', 'yes')}</span><span>не знаю · сомневаюсь · знаю</span></div></div>`;
    box.querySelectorAll('.hand button').forEach(b => b.addEventListener('click', () => { S.hand = b.dataset.h; saveS(); renderKeys(); setTitles(); }));
    setTitles();
  }
  function setTitles() {
    const L = LAYOUTS[S.hand].lab, set = (sel, txt) => { const el = $(sel); if (el) el.title = txt; };
    set('#pBack', `К списку (${L.back})`); set('#bPV', `Предыдущий глагол (${L.pv})`); set('#bPS', `Предыдущая фраза (${L.prev})`);
    set('#bP', 'Играть / пауза (Пробел)'); set('#bNS', `Следующая фраза (${L.next})`); set('#bNV', `Следующий глагол (${L.nv})`);
    set('.rate [data-r="no"]', `Не знаю (${L.no})`); set('.rate [data-r="doubt"]', `Сомневаюсь (${L.doubt})`); set('.rate [data-r="yes"]', `Знаю (${L.yes})`);
  }
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const inPlayer = $('#player') && $('#player').classList.contains('open');
    if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return; }
    const c = e.code, K = LAYOUTS[S.hand];
    if (!inPlayer) { if (c === K.find && $('#q')) { e.preventDefault(); $('#q').focus(); } return; }
    if (c === 'Space') { e.preventDefault(); togglePlay(); }
    else if (c === K.next || c === 'ArrowRight') { e.preventDefault(); stepPhrase(1); }
    else if (c === K.prev || c === 'ArrowLeft') { e.preventDefault(); stepPhrase(-1); }
    else if (c === K.nv) stepVerb(1);
    else if (c === K.pv) stepVerb(-1);
    else if (c === K.m1) setMode('listen'); else if (c === K.m2) setMode('repeat'); else if (c === K.m3) setMode('recall');
    else if (c === K.no) rate('no'); else if (c === K.doubt) rate('doubt'); else if (c === K.yes) rate('yes');
    else if (c === K.back || c === 'Escape') { e.preventDefault(); closePlayer(); }
  });

  // ---------- запуск ----------
  function start() { STOP = new Set(DATA.stop || []); LIST = DATA.verbs; BYID = Object.fromEntries(LIST.map(v => [v.id, v])); renderHome(); }
  async function boot() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
    let key = null, have = 0;
    try { key = await DB.get('meta', 'key'); have = key ? await DB.count('audio') : 0; } catch { /* нет IndexedDB */ }
    if (key && have > 0) {
      try { DATA = await decryptWith(key); start(); } catch (e) { renderSetup('Не удалось открыть данные: ' + (e.message || e)); }
    } else renderSetup();
  }
  window.GL = { importPack, boot, start: () => start(), db: DB, S, get cur() { return cur; }, get data() { return DATA; }, get mem() { return MEM; }, get lastGain() { return lastGain; }, setData: d => { DATA = d; } };
  boot();
})();
