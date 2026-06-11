/* core.js — spoločné jadro aplikácie VELITEĽ Zásah (v6)
 *
 * Stránka (byty/sklad/hazmat) definuje vlastnú konfiguráciu a zavolá coreSetup(config).
 * Konfigurácia:
 *   key             - kľúč v localStorage
 *   typeLabel       - názov typu zásahu (do reportu a denníka)
 *   baseLoc         - východzia poloha novej skupiny ('BASE' / 'SAFE')
 *   defaults        - extra polia stavu (floors, apts, zones...)
 *   renderMap()     - vykreslenie mapy (štruktúry priestorov)
 *   badgeContainer(loc) - id elementu, do ktorého patrí odznak skupiny v danej polohe
 *   highlightTargets()  - zvýraznenie cieľa vybranej skupiny na mape
 *   reportDetail()  - HTML sekcie "Detail priestorov" v reporte
 *   locLabel(loc)   - čitateľný názov polohy (voliteľné)
 *   onRoomUpdated(id, field) - hook po zmene priestoru (voliteľné)
 *   calcTotals()    - vlastný výpočet footera (voliteľné)
 *   reportTotals()  - vlastný súhrn do reportu (voliteľné)
 */
'use strict';

const APP_VERSION = '6.3';

const COLORS =[{bg:'#007bff',txt:'white'},{bg:'#ffd700',txt:'black'},{bg:'#28a745',txt:'white'},{bg:'#dc3545',txt:'white'},{bg:'#17a2b8',txt:'black'},{bg:'#6f42c1',txt:'white'},{bg:'#fd7e14',txt:'black'},{bg:'#e83e8c',txt:'white'},{bg:'#8B4513',txt:'white'},{bg:'#000000',txt:'white'}];

let CFG = null;
let APP = null;
let _loop = null;
let _wakeLock = null;
let _audioCtx = null;
let _modId = null;
let _lastMove = null;
let _lastBeep = 0;
let _saveTick = 0;
let _toastTimer = null;
let _activeTab = 'map';
let _overview = false;
let _secretTaps = 0;
let _wiped = false; /* po vymazaní dát blokuje auto-ukladanie, aby ich nevzkriesilo */

/* ===================== STAV A PERZISTENCIA ===================== */

function coreBaseState() {
    return {
        rooms: {}, groups: [], selectedGroupId: null,
        intervals: [900, 1200, 1500],
        logs: [], lastId: 0, isRunning: false,
        meta: { addr: '', cmdr: '', startTs: null, endTs: null }
    };
}

function saveData() { if (!_wiped && APP && APP.isRunning) { try { localStorage.setItem(CFG.key, JSON.stringify(APP)); } catch (e) {} } }

function coreLoadData() {
    const d = localStorage.getItem(CFG.key);
    if (!d) return false;
    try {
        APP = Object.assign(coreBaseState(), CFG.defaults || {}, JSON.parse(d));
        if (!APP.meta) APP.meta = { addr: '', cmdr: '', startTs: null, endTs: null };
        return true;
    } catch (e) { return false; }
}

/* Vymaže aktívny zásah a vráti appku na úvodné nastavenie.
 * _wiped + isRunning=false zaručia, že auto-ukladanie (beforeunload,
 * visibilitychange) dáta pri reštarte nezapíše späť. */
function wipeActive() {
    _wiped = true;
    if (APP) APP.isRunning = false;
    localStorage.removeItem(CFG.key);
    (CFG.legacyKeys || []).forEach(k => localStorage.removeItem(k));
    location.reload();
}

function forceReset() {
    if (!confirm('Naozaj vymazať všetky dáta tohto zásahu?')) return;
    if (!confirm('Údaje sa NENÁVRATNE stratia — bez uloženia do archívu. Pokračovať?')) return;
    wipeActive();
}

function exportJSON() {
    const blob = new Blob([JSON.stringify(APP, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zasah_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
}

/* ===================== ŠTART / OBNOVA ===================== */

function coreSetup(config) {
    CFG = config;
    APP = Object.assign(coreBaseState(), CFG.defaults || {});
    coreInjectChrome();
    /* tlačidlo archívu na setup obrazovke (zobrazí sa, len ak archív nie je prázdny) */
    const sc = document.querySelector('.setup-scroll');
    if (sc) {
        const b = document.createElement('button');
        b.id = 'btnArchive';
        b.className = 'btn-big';
        b.style.background = '#555';
        b.style.display = 'none';
        b.onclick = archOpen;
        sc.appendChild(b);
        refreshArchBtn();
    }
    coreApplyDark(localStorage.getItem('VELITEL_DARK') === '1');
    coreDualWatch();
    document.addEventListener('pointerdown', coreInitAudio);
    window.addEventListener('beforeunload', () => { try { saveData(); } catch (e) {} });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { try { saveData(); } catch (e) {} }
        else if (APP && APP.isRunning) { coreWakeLock(); refreshAll(); }
    });
    document.querySelectorAll('.ver').forEach(el => el.innerText = 'v' + APP_VERSION);
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js');
        /* nová verzia prevzala kontrolu — ponúkni obnovenie */
        let hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (hadController) showToast('Aplikácia bola aktualizovaná na novú verziu.', 'OBNOVIŤ', () => location.reload());
            hadController = true;
        });
    }

    if (coreLoadData() && APP.isRunning) {
        document.getElementById('setupScreen').style.display = 'none';
        CFG.renderMap();
        renderLogAll();
        refreshAll();
        coreStartRuntime();
        updateFinishUI();
        if (!APP.meta.endTs) dbLog('— Obnovenie relácie —');
    }
}

/* Stránka volá po vytvorení vlastných priestorov v appInit(). */
function coreStartIncident() {
    APP.meta.addr = inputVal('inpAddr');
    APP.meta.cmdr = inputVal('inpCmdr');
    APP.meta.startTs = Date.now();
    APP.meta.endTs = null;
    APP.intervals = [numVal('inpInt1', 15) * 60, numVal('inpInt2', 20) * 60, numVal('inpInt3', 25) * 60];
    const tm = document.getElementById('chkTestMode');
    if (tm && tm.checked) APP.intervals = [15, 30, 45];
    APP.isRunning = true;
    document.getElementById('setupScreen').style.display = 'none';
    CFG.renderMap();
    renderLogAll();
    refreshAll();
    coreStartRuntime();
    updateFinishUI();
    dbLog('ŠTART ZÁSAHU: ' + CFG.typeLabel + (APP.meta.addr ? ' — ' + APP.meta.addr : ''));
    saveData();
}

function coreStartRuntime() {
    if (_loop) clearInterval(_loop);
    _loop = setInterval(gameLoop, 1000);
    const ind = document.getElementById('sysIndicator');
    if (ind) ind.classList.add('sys-running');
    coreWakeLock();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
}

function inputVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function numVal(id, def) { const el = document.getElementById(id); if (!el) return def; const v = parseInt(el.value); return (isNaN(v) || v <= 0) ? def : v; }

/* Skrytý prepínač testovacieho režimu — 5 ťuknutí na nadpis setup obrazovky. */
function setupSecretTap() {
    if (++_secretTaps >= 5) {
        const w = document.getElementById('testModeWrap');
        if (w) w.style.display = 'block';
    }
}

/* ===================== WAKE LOCK (nezhasínať obrazovku) ===================== */

async function coreWakeLock() {
    try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
            _wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (e) {}
}

/* ===================== ZVUK A VIBRÁCIE ===================== */

function coreInitAudio() {
    try {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (_audioCtx.state === 'suspended') _audioCtx.resume();
    } catch (e) {}
}

function coreBeep(lvl) {
    coreInitAudio();
    if (_audioCtx) {
        try {
            const t = _audioCtx.currentTime;
            for (let i = 0; i < 3; i++) {
                const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
                o.type = 'square';
                o.frequency.value = 900 + lvl * 150;
                g.gain.setValueAtTime(0.5, t + i * 0.35);
                g.gain.setValueAtTime(0.0001, t + i * 0.35 + 0.25);
                o.connect(g); g.connect(_audioCtx.destination);
                o.start(t + i * 0.35); o.stop(t + i * 0.35 + 0.26);
            }
        } catch (e) {}
    }
    if (navigator.vibrate) { try { navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) {} }
}

/* ===================== ČAS ===================== */

/* Čas skupiny sa počíta z timestampu štartu — beží správne aj keď
 * prehliadač/zariadenie pozastaví JavaScript (zhasnutá obrazovka, reštart). */
function groupElapsed(g) {
    let e = g.elapsedAcc || 0;
    if (g.runningSince) e += (Date.now() - g.runningSince) / 1000;
    return Math.floor(e);
}

function fmtTime(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(sec) : p(m) + ':' + p(sec);
}

/* ===================== SKUPINY ===================== */

function findG(id) { return APP.groups.find(x => x.id === id); }

function coreAddGroup(name) {
    APP.lastId++;
    const id = APP.lastId;
    APP.groups.push({ id, name, loc: CFG.baseLoc, status: 'active', elapsedAcc: 0, runningSince: null, alarmLevel: 0, ackLevel: 0, members: 2, colorObj: COLORS[(id - 1) % COLORS.length] });
    APP.selectedGroupId = id;
    dbLog('Vytvorená skupina: ' + name);
    refreshAll();
    saveData();
}

function addForce() { coreAddGroup('SKUPINA ' + (APP.groups.length + 1)); }

function renameGroup(id) {
    const g = findG(id);
    const n = prompt('Názov skupiny:', g.name);
    if (n && n.trim() && n.trim() !== g.name) {
        dbLog('Premenovanie: ' + g.name + ' → ' + n.trim());
        g.name = n.trim();
        refreshAll();
        saveData();
    }
}

function logicTimerStart(id) {
    const g = findG(id);
    if (g.runningSince) return;
    g.runningSince = Date.now();
    dbLog(g.name + ': ŠTART časovača ADP (poloha ' + locLabel(g.loc) + ')');
    refreshAll();
    saveData();
}

function logicTimerStop(id) {
    const g = findG(id);
    if (!g.runningSince) return;
    g.elapsedAcc = groupElapsed(g);
    g.runningSince = null;
    dbLog(g.name + ': STOP časovača ADP (čas ' + fmtTime(g.elapsedAcc) + ')');
    refreshAll();
    saveData();
}

function resetAir() {
    if (!confirm('Výmena fliaš — vynulovať časovač ADP?')) return;
    const g = findG(_modId);
    dbLog(g.name + ': VÝMENA FLIAŠ (čas pred výmenou ' + fmtTime(groupElapsed(g)) + ')');
    g.elapsedAcc = 0;
    if (g.runningSince) g.runningSince = Date.now();
    g.alarmLevel = 0;
    g.ackLevel = 0;
    uiCloseModal();
    refreshAll();
    saveData();
}

function removeForce() {
    if (!confirm('Ukončiť činnosť skupiny?')) return;
    const g = findG(_modId);
    if (g.runningSince) { g.elapsedAcc = groupElapsed(g); g.runningSince = null; }
    g.status = 'finished';
    if (APP.selectedGroupId === g.id) APP.selectedGroupId = null;
    dbLog(g.name + ': UKONČENÁ ČINNOSŤ (celkový čas ADP ' + fmtTime(g.elapsedAcc) + ')');
    uiCloseModal();
    refreshAll();
    saveData();
}

function confirmCheck() {
    const g = findG(_modId);
    g.ackLevel = g.alarmLevel;
    dbLog(g.name + ': potvrdená kontrola č.' + g.alarmLevel);
    uiCloseModal();
    refreshAll();
    saveData();
}

function stepMembers(id, d) {
    const g = findG(id);
    g.members = Math.max(0, (parseInt(g.members) || 0) + d);
    const i = document.getElementById('mem_' + id);
    if (i) i.value = g.members;
    updateFooter();
    saveData();
}

function dbUpdateMember(id, v) {
    findG(id).members = Math.max(0, parseInt(v) || 0);
    updateFooter();
    saveData();
}

/* ===================== HLAVNÁ SLUČKA ===================== */

function gameLoop() {
    let redraw = false, anyAlarm = false;
    APP.groups.forEach(g => {
        if (g.status === 'finished') return;
        const e = groupElapsed(g);
        if (g.runningSince) {
            const el = document.getElementById('tm_' + g.id);
            if (el) el.innerText = fmtTime(e);
            for (let i = 0; i < 3; i++) {
                if (e >= APP.intervals[i] && g.alarmLevel === i) {
                    g.alarmLevel = i + 1;
                    redraw = true;
                    dbLog(g.name + ': ⏰ KONTROLA č.' + (i + 1) + ' (limit ' + fmtTime(APP.intervals[i]) + ')');
                }
            }
        }
        if (g.alarmLevel > g.ackLevel) anyAlarm = true;
    });
    /* nepotvrdený alarm pípa a vibruje opakovane, kým ho veliteľ nepotvrdí */
    if (anyAlarm && Date.now() - _lastBeep > 4000) {
        _lastBeep = Date.now();
        coreBeep(2);
    }
    if (redraw) refreshAll();
    updateFooter();
    if (++_saveTick >= 10) { _saveTick = 0; saveData(); }
}

/* ===================== PRIESTORY ===================== */

function dbCreateRoom(id) { APP.rooms[id] = { s: false, k: false, p: 0, i: 0, d: 0, e: 0 }; }

function dbUpdateRoom(id, f, v) {
    const r = APP.rooms[id];
    if (!r) return;
    if (f !== 's' && f !== 'k') v = Math.max(0, parseInt(v) || 0);
    const old = r[f];
    r[f] = v;
    if (f === 's' && v === true && old === false) dbLog(id + ': PREHĽADANÉ');
    if (f === 's' && v === false && old === true) dbLog(id + ': zrušené označenie PREHĽADANÉ');
    if (f === 'p' && v > old) dbLog(id + ': nájdená OSOBA (spolu ' + v + ')');
    if (f === 'i' && v > old) dbLog(id + ': ZRANENÝ (spolu ' + v + ')');
    if (f === 'd' && v > old) dbLog(id + ': EXITUS (spolu ' + v + ')');
    if (f === 'e' && v > old) dbLog(id + ': EVAKUOVANÍ (spolu ' + v + ')');
    if (CFG.onRoomUpdated) CFG.onRoomUpdated(id, f);
    updateFooter();
    saveData();
}

function stepRoom(id, f, d) {
    const r = APP.rooms[id];
    if (!r) return;
    const v = Math.max(0, (parseInt(r[f]) || 0) + d);
    const inp = document.getElementById('inp_' + id + '_' + f);
    if (inp) inp.value = v;
    dbUpdateRoom(id, f, v);
}

function stepperHTML(id, f, value, cls) {
    return '<div class="stepper ' + (cls || '') + '">' +
        '<button type="button" onclick="stepRoom(\'' + id + '\',\'' + f + '\',-1)">−</button>' +
        '<input id="inp_' + id + '_' + f + '" type="number" value="' + value + '" onclick="this.select()" onchange="dbUpdateRoom(\'' + id + '\',\'' + f + '\',this.value);this.value=APP.rooms[\'' + id + '\'].' + f + '">' +
        '<button type="button" onclick="stepRoom(\'' + id + '\',\'' + f + '\',1)">+</button></div>';
}

/* ===================== VÝBER A PRESUN SKUPÍN ===================== */

function logicSelectGroup(id) {
    APP.selectedGroupId = (APP.selectedGroupId === id) ? null : id;
    refreshAll();
}

function cancelMove() { APP.selectedGroupId = null; refreshAll(); }

function logicBadgeClick(id) {
    const g = findG(id);
    if (g.alarmLevel > g.ackLevel) logicOpenGroupModal(id);
    else logicSelectGroup(id);
}

function logicHandleRoomClick(loc) {
    if (!APP.selectedGroupId) return;
    const g = findG(APP.selectedGroupId);
    if (!g) return;
    const old = g.loc;
    APP.selectedGroupId = null;
    if (old === loc) { refreshAll(); return; }
    g.loc = loc;
    dbLog(g.name + ': presun ' + locLabel(old) + ' → ' + locLabel(loc));
    _lastMove = { id: g.id, from: old };
    showToast(g.name + ' → ' + locLabel(loc), 'SPÄŤ', undoMove);
    refreshAll();
    saveData();
}

function undoMove() {
    if (_lastMove) {
        const g = findG(_lastMove.id);
        if (g) {
            dbLog(g.name + ': presun vrátený späť → ' + locLabel(_lastMove.from));
            g.loc = _lastMove.from;
            refreshAll();
            saveData();
        }
        _lastMove = null;
    }
    hideToast();
}

function locLabel(l) {
    if (CFG.locLabel) { const x = CFG.locLabel(l); if (x) return x; }
    if (l === 'BASE') return 'ZÁKLADŇA';
    if (l === 'SAFE') return 'NÁSTUP. PRIESTOR';
    return l;
}

/* ===================== VYKRESLENIE ===================== */

function refreshAll() {
    renderGroupList();
    renderBadges();
    updateMoveBanner();
    updateFooter();
}

function renderBadges() {
    document.querySelectorAll('.badge-zone, .badge-container').forEach(el => el.innerHTML = '');
    APP.groups.forEach(g => {
        if (g.status === 'finished') return;
        const b = document.createElement('span');
        b.className = 'badge' + (APP.selectedGroupId === g.id ? ' selected' : '') + (g.alarmLevel > g.ackLevel ? ' badge-alarm' : '');
        b.style.backgroundColor = g.colorObj.bg;
        b.style.color = g.colorObj.txt;
        b.innerText = g.name;
        b.onclick = (e) => { e.stopPropagation(); logicBadgeClick(g.id); };
        const z = document.getElementById(CFG.badgeContainer(g.loc));
        if (z) z.appendChild(b);
    });
    if (CFG.highlightTargets) CFG.highlightTargets();
}

function renderGroupList() {
    const area = document.getElementById('forcesList');
    if (!area) return;
    area.innerHTML = '';
    APP.groups.forEach(g => {
        if (g.status === 'finished') return;
        const alarm = (g.alarmLevel > g.ackLevel);
        const run = !!g.runningSince;
        const div = document.createElement('div');
        div.className = 'group-card' + (APP.selectedGroupId === g.id ? ' selected' : '') + (alarm ? ' card-alarm' : '');
        div.onclick = () => logicSelectGroup(g.id);
        div.innerHTML =
            '<div class="card-color-strip" style="background:' + g.colorObj.bg + '"></div>' +
            '<div class="card-header">' +
                '<div class="card-title"><b>' + esc(g.name) + '</b> <button class="btn-rename" title="Premenovať" onclick="event.stopPropagation();renameGroup(' + g.id + ')">✏️</button><br><small>📍 ' + esc(locLabel(g.loc)) + '</small></div>' +
                '<div class="card-timer ' + (run ? 'running' : '') + '" id="tm_' + g.id + '">' + fmtTime(groupElapsed(g)) + '</div>' +
            '</div>' +
            '<div class="card-members" onclick="event.stopPropagation()">Hasiči:' +
                '<div class="stepper"><button type="button" onclick="stepMembers(' + g.id + ',-1)">−</button><input id="mem_' + g.id + '" type="number" value="' + g.members + '" onclick="this.select()" onchange="dbUpdateMember(' + g.id + ',this.value)"><button type="button" onclick="stepMembers(' + g.id + ',1)">+</button></div>' +
            '</div>' +
            '<div class="card-controls">' +
                (alarm ? '<button class="btn-ctrl btn-confirm" onclick="event.stopPropagation();logicOpenGroupModal(' + g.id + ')">🚨 ALARM!</button>' : '') +
                (run
                    ? '<button class="btn-ctrl" style="background:#c62828" onclick="event.stopPropagation();logicTimerStop(' + g.id + ')">⏸ STOP</button>'
                    : '<button class="btn-ctrl" style="background:#2e7d32" onclick="event.stopPropagation();logicTimerStart(' + g.id + ')">▶ ŠTART</button>') +
                '<button class="btn-ctrl" style="background:#333" onclick="event.stopPropagation();logicOpenGroupModal(' + g.id + ')">INFO</button>' +
            '</div>';
        area.appendChild(div);
    });
}

function updateMoveBanner() {
    const b = document.getElementById('moveBanner');
    if (!b) return;
    const g = APP.selectedGroupId ? findG(APP.selectedGroupId) : null;
    if (g) {
        document.getElementById('moveBannerText').innerHTML = 'Presun: <b>' + esc(g.name) + '</b> — ťukni na cieľový priestor na mape';
        b.style.display = 'flex';
    } else {
        b.style.display = 'none';
    }
}

/* ===================== FOOTER ===================== */

function updateFooter() {
    if (CFG.calcTotals) CFG.calcTotals(); else defaultCalcTotals();
    const t = document.getElementById('statTime');
    if (t && APP.meta.startTs) t.innerText = fmtTime(((APP.meta.endTs || Date.now()) - APP.meta.startTs) / 1000);
    const n = document.getElementById('statNext');
    if (n) {
        let best = null;
        APP.groups.forEach(g => {
            if (g.status === 'finished' || !g.runningSince) return;
            const e = groupElapsed(g);
            for (const iv of APP.intervals) {
                if (e < iv) {
                    const r = iv - e;
                    if (!best || r < best.r) best = { r, name: g.name };
                    break;
                }
            }
        });
        n.innerText = best ? fmtTime(best.r) : '—';
        const lbl = document.getElementById('statNextName');
        if (lbl) lbl.innerText = best ? best.name : 'KONTROLA O';
    }
}

function defaultCalcTotals() {
    let s = 0, p = 0, i = 0, d = 0, e = 0;
    Object.values(APP.rooms).forEach(r => { if (r.s) s++; p += r.p; i += r.i; d += r.d; e += r.e; });
    setTxt('statSearch', s); setTxt('statPers', p); setTxt('statInj', i); setTxt('statDead', d); setTxt('statEvac', e);
    return { s, p, i, d, e };
}

function setTxt(id, v) { const el = document.getElementById(id); if (el) el.innerText = String(v); }

/* ===================== MODAL SKUPINY ===================== */

function logicOpenGroupModal(id) {
    _modId = id;
    const g = findG(id);
    document.getElementById('mTitle').innerText = g.name;
    document.getElementById('mInfo').innerText = 'Poloha: ' + locLabel(g.loc) + ' | Čas ADP: ' + fmtTime(groupElapsed(g)) + ' | Hasiči: ' + g.members;
    const alarm = g.alarmLevel > g.ackLevel;
    document.getElementById('mAlarm').style.display = alarm ? 'block' : 'none';
    document.getElementById('mBtnCheck').style.display = alarm ? 'block' : 'none';
    document.getElementById('modalGroup').style.display = 'flex';
}

function moveGroupFromModal() {
    APP.selectedGroupId = _modId;
    uiCloseModal();
    switchTab('map');
    refreshAll();
}

function uiCloseModal() { document.getElementById('modalGroup').style.display = 'none'; }

/* ===================== ZÁLOŽKY A DVOJPANEL ===================== */

function switchTab(t) {
    _activeTab = t;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
    const map = { map: 'viewMap', forces: 'viewForces', log: 'viewLog' };
    const el = document.getElementById(map[t]);
    if (el) el.classList.add('active');
}

const _dualMq = window.matchMedia('(min-width: 900px)');
function coreDualWatch() {
    applyDual();
    if (_dualMq.addEventListener) _dualMq.addEventListener('change', applyDual);
    else _dualMq.addListener(applyDual);
}
function applyDual() {
    document.body.classList.toggle('dual', _dualMq.matches);
    if (_dualMq.matches && _activeTab === 'forces') switchTab('map');
}

/* ===================== NOČNÝ REŽIM ===================== */

function toggleDark() {
    const on = !document.body.classList.contains('dark');
    coreApplyDark(on);
    localStorage.setItem('VELITEL_DARK', on ? '1' : '0');
}
function coreApplyDark(on) { document.body.classList.toggle('dark', !!on); }

/* ===================== CELÝ POHĽAD (zmenšenie mapy) ===================== */

function toggleOverview() {
    _overview = !_overview;
    const w = document.getElementById('mapScaleWrapper');
    if (_overview) {
        const h = window.innerHeight - 150;
        const s = Math.min(h / w.scrollHeight, 1);
        w.style.width = '100%';
        w.style.transform = 'scale(' + s + ')';
        w.style.width = (100 / s) + '%';
    } else {
        w.style.transform = 'scale(1)';
        w.style.width = '100%';
    }
}

/* ===================== DENNÍK ===================== */

function dbLog(m) {
    const l = { t: new Date().toLocaleTimeString('sk-SK'), m };
    APP.logs.push(l);
    const c = document.getElementById('logContent');
    if (c) c.insertAdjacentHTML('afterbegin', logLineHTML(l));
    saveData();
}

function logLineHTML(l) { return '<div class="log-line"><b>' + esc(l.t) + '</b> ' + esc(l.m) + '</div>'; }

function renderLogAll() {
    const c = document.getElementById('logContent');
    if (!c) return;
    c.innerHTML = APP.logs.slice().reverse().map(logLineHTML).join('');
}

function addManualLog() {
    const i = document.getElementById('manualLogInput');
    const v = i.value.trim();
    if (!v) return;
    dbLog('📝 ' + v);
    i.value = '';
}

/* ===================== TOAST ===================== */

function showToast(msg, btnLabel, btnFn) {
    const t = document.getElementById('coreToast');
    document.getElementById('coreToastMsg').innerText = msg;
    const b = document.getElementById('coreToastBtn');
    if (btnLabel) { b.style.display = 'inline-block'; b.innerText = btnLabel; b.onclick = btnFn; }
    else b.style.display = 'none';
    t.style.display = 'flex';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(hideToast, 6000);
}

function hideToast() { document.getElementById('coreToast').style.display = 'none'; }

/* ===================== UKONČENIE A PDF PREHĽAD ===================== */

function finishIncident() {
    /* už ukončený zásah — len opätovná tlač PDF */
    if (APP.meta.endTs) {
        buildReport();
        window.print();
        return;
    }
    if (!confirm('Ukončiť zásah a vytvoriť PDF prehľad? (zastaví všetky časovače ADP)')) return;
    APP.groups.forEach(g => {
        if (g.runningSince) {
            g.elapsedAcc = groupElapsed(g);
            g.runningSince = null;
            dbLog(g.name + ': STOP časovača ADP — ukončenie zásahu (čas ' + fmtTime(g.elapsedAcc) + ')');
        }
    });
    APP.meta.endTs = Date.now();
    dbLog('UKONČENIE ZÁSAHU');
    refreshAll();
    updateFinishUI();
    saveData();
    buildReport();
    window.print();
}

/* Po ukončení zásahu sa zmení tlačidlo tlače, objaví sa NOVÝ ZÁSAH
 * a indikátor prestane pulzovať. */
function updateFinishUI() {
    const ended = !!(APP.meta && APP.meta.endTs);
    const fin = document.getElementById('btnFinish');
    if (fin) fin.innerText = ended ? '🖨 VYTLAČIŤ PDF ZNOVA' : '🏁 UKONČIŤ ZÁSAH A VYTVORIŤ PDF';
    const nw = document.getElementById('btnNew');
    if (nw) nw.style.display = ended ? 'block' : 'none';
    const ind = document.getElementById('sysIndicator');
    if (ind) ind.classList.toggle('sys-running', !!APP.isRunning && !ended);
}

function newIncident() {
    if (!confirm('Začať nový zásah? Ukončený zásah sa uloží do archívu (na úvodnej obrazovke).')) return;
    archiveCurrent();
    wipeActive();
}

/* ===================== ARCHÍV ZÁSAHOV ===================== */

const ARCHIVE_KEY = 'VELITEL_ARCHIV_V1';
const ARCHIVE_MAX = 20;

function readArchive() {
    try { return JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]'); } catch (e) { return []; }
}
function writeArchive(list) {
    try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list)); } catch (e) {}
}
function archEntries() { return readArchive().filter(e => e.page === CFG.key); }

function archiveCurrent() {
    if (!APP || !APP.isRunning) return;
    const list = readArchive();
    list.unshift({ page: CFG.key, type: CFG.typeLabel, ts: Date.now(), data: APP });
    while (list.length > ARCHIVE_MAX) list.pop();
    writeArchive(list);
}

function refreshArchBtn() {
    const b = document.getElementById('btnArchive');
    if (!b) return;
    const n = archEntries().length;
    b.innerText = '📁 ARCHÍV ZÁSAHOV (' + n + ')';
    b.style.display = n ? 'block' : 'none';
}

function archOpen() {
    const wrap = document.getElementById('archList');
    const list = archEntries();
    wrap.innerHTML = list.length ? '' : '<p>Archív je prázdny.</p>';
    list.forEach(e => {
        const m = (e.data && e.data.meta) || {};
        const when = m.startTs ? new Date(m.startTs).toLocaleString('sk-SK') : new Date(e.ts).toLocaleString('sk-SK');
        const div = document.createElement('div');
        div.className = 'arch-item';
        div.innerHTML = '<div class="arch-info"><b>' + esc(when) + '</b>' + (m.addr ? '<br>' + esc(m.addr) : '') + '</div>' +
            '<div class="arch-actions">' +
            '<button onclick="archPrint(' + e.ts + ')">🖨 PDF</button>' +
            '<button class="arch-del" onclick="archDelete(' + e.ts + ')">🗑</button>' +
            '</div>';
        wrap.appendChild(div);
    });
    document.getElementById('modalArchive').style.display = 'flex';
}

function archClose() { document.getElementById('modalArchive').style.display = 'none'; }

function archPrint(ts) {
    const e = readArchive().find(x => x.ts === ts);
    if (!e) return;
    /* report sa skladá z globálneho APP — dočasne ho nahradíme archivovaným */
    const keep = APP;
    APP = Object.assign(coreBaseState(), CFG.defaults || {}, e.data);
    try {
        buildReport();
        window.print();
    } finally {
        APP = keep;
    }
}

function archDelete(ts) {
    if (!confirm('Vymazať tento zásah z archívu?')) return;
    writeArchive(readArchive().filter(x => x.ts !== ts));
    refreshArchBtn();
    archOpen();
}

function buildReport() {
    const fmtD = ts => ts ? new Date(ts).toLocaleString('sk-SK') : '—';
    setTxt('repType', CFG.typeLabel);
    setTxt('repAddr', APP.meta.addr || '—');
    setTxt('repCmdr', APP.meta.cmdr || '—');
    setTxt('repPrinted', new Date().toLocaleString('sk-SK'));
    setTxt('repStart', fmtD(APP.meta.startTs));
    setTxt('repEnd', fmtD(APP.meta.endTs));
    setTxt('repDur', (APP.meta.startTs && APP.meta.endTs) ? fmtTime((APP.meta.endTs - APP.meta.startTs) / 1000) : '—');
    const s = CFG.reportTotals ? CFG.reportTotals() : defaultCalcTotals();
    setTxt('repSearch', s.s); setTxt('repPers', s.p); setTxt('repInj', s.i); setTxt('repDead', s.d); setTxt('repEvac', s.e);
    document.getElementById('repDetail').innerHTML = CFG.reportDetail();
    let t = '', total = 0;
    APP.groups.forEach(g => {
        total += parseInt(g.members) || 0;
        t += '<tr><td>' + esc(g.name) + '</td><td>' + g.members + '</td><td>' + esc(locLabel(g.loc)) + '</td><td>' + fmtTime(groupElapsed(g)) + '</td><td>' + (g.status === 'finished' ? 'ukončená' : 'aktívna') + '</td></tr>';
    });
    document.getElementById('repGroupTable').innerHTML = t || '<tr><td colspan="5">Žiadne skupiny</td></tr>';
    setTxt('repTotalMem', total);
    document.getElementById('repLog').innerText = APP.logs.map(l => '[' + l.t + '] ' + l.m).join('\n');
}

/* ===================== POMOCNÉ ===================== */

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* Spoločné prvky UI (banner, toast, modal, kostra reportu) vloží jadro samo,
 * aby ich stránky nemuseli duplikovať. */
function coreInjectChrome() {
    const wrap = document.createElement('div');
    wrap.innerHTML =
        '<div id="moveBanner" class="move-banner" style="display:none"><span id="moveBannerText"></span><button onclick="cancelMove()">✕ ZRUŠIŤ</button></div>' +
        '<div id="coreToast" class="core-toast" style="display:none"><span id="coreToastMsg"></span><button id="coreToastBtn"></button></div>' +
        '<div id="modalGroup" class="modal-wrap"><div class="modal-box">' +
            '<h2 id="mTitle">…</h2><p id="mInfo">…</p>' +
            '<div id="mAlarm" class="modal-alarm" style="display:none">🚨 KONTROLA SKUPINY!</div>' +
            '<button id="mBtnCheck" class="btn-big" style="background:orange;color:black;display:none" onclick="confirmCheck()">✔ POTVRDIŤ KONTROLU</button>' +
            '<button class="btn-big" style="background:#007bff" onclick="moveGroupFromModal()">📍 PRESUNÚŤ</button>' +
            '<button class="btn-big" style="background:#f9a825;color:black" onclick="resetAir()">🔄 NOVÝ VZDUCH (výmena fliaš)</button>' +
            '<button class="btn-big" style="background:#d32f2f" onclick="removeForce()">🏁 UKONČIŤ ČINNOSŤ</button>' +
            '<button class="btn-big" style="background:#777" onclick="uiCloseModal()">ZAVRIEŤ</button>' +
        '</div></div>' +
        '<div id="modalArchive" class="modal-wrap"><div class="modal-box">' +
            '<h2 style="margin-top:0">📁 Archív zásahov</h2>' +
            '<div id="archList"></div>' +
            '<button class="btn-big" style="background:#777" onclick="archClose()">ZAVRIEŤ</button>' +
        '</div></div>' +
        '<div id="final-report">' +
            '<h1>PREHĽAD O ZÁSAHU <small style="font-size:14px;font-weight:normal">(pomôcka veliteľa — nie je oficiálna správa)</small></h1>' +
            '<table class="rep-table rep-meta">' +
                '<tr><th>Typ zásahu</th><td id="repType"></td><th>Adresa / objekt</th><td id="repAddr"></td></tr>' +
                '<tr><th>Veliteľ zásahu</th><td id="repCmdr"></td><th>Vytlačené</th><td id="repPrinted"></td></tr>' +
                '<tr><th>Začiatok</th><td id="repStart"></td><th>Koniec</th><td id="repEnd"></td></tr>' +
                '<tr><th>Trvanie</th><td id="repDur" colspan="3"></td></tr>' +
            '</table>' +
            '<h3>1. Súhrn</h3>' +
            '<table class="rep-table"><tr><th>Prehľadané</th><th>Osoby</th><th>Zranení</th><th>Exitus</th><th>Evakuovaní</th></tr>' +
            '<tr><td id="repSearch"></td><td id="repPers"></td><td id="repInj"></td><td id="repDead"></td><td id="repEvac"></td></tr></table>' +
            '<h3>2. Detail priestorov</h3><div id="repDetail"></div>' +
            '<h3>3. Nasadené sily</h3>' +
            '<p><strong>Spolu hasičov:</strong> <span id="repTotalMem">0</span></p>' +
            '<table class="rep-table"><thead><tr><th>Skupina</th><th>Členov</th><th>Posledná poloha</th><th>Čas ADP</th><th>Stav</th></tr></thead><tbody id="repGroupTable"></tbody></table>' +
            '<h3>4. Denník zásahu</h3><div id="repLog"></div>' +
        '</div>';
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
}
