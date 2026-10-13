/**
 * Сетка закрепов на главной Т—Ж — серверная часть.
 * Живет внутри Google-таблицы (Расширения → Apps Script).
 * Хранит сетку и заявки на двух листах: grid и requests.
 * Пароль модератора хранится в свойствах скрипта (MOD_PASSWORD) и в код страницы не попадает.
 */

const LIMIT = 10; // не больше слотов на одну редакцию в месяц
const COLS = ['ama', 's1', 's2', 'c1', 'c2', 'c3'];

/* ---------- входные точки ---------- */

function doGet() {
  return out_({ ok: true, state: state_() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const res = handle_(body) || {};
    res.ok = true;
    res.state = state_();
    return out_(res);
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- действия ---------- */

function handle_(b) {
  switch (b.action) {
    case 'login': {
      needMod_(b);
      return {};
    }

    case 'createRequest': {
      const d = b.doc || {};
      cellId_(d.date, d.col);
      const rubric = str_(d.rubric, 80).trim();
      const url = str_(d.url, 500).trim();
      const note = str_(d.note, 1000).trim();
      const authorName = str_(d.authorName, 80).trim();
      if (!rubric) throw new Error('Выбери редакцию');
      if (!authorName) throw new Error('Напиши свое имя');
      if (!url && !note) throw new Error('Добавь ссылку, слаг или пару слов о материале');
      const used = rubricLoad_(rubric, d.date);
      if (used >= LIMIT) {
        throw new Error('У редакции уже ' + used + ' слотов в этом месяце. Больше ' + LIMIT + ' занять нельзя.');
      }
      const id = 'r' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
      const token = Utilities.getUuid();
      put_('requests', id, {
        date: d.date, col: d.col, rubric: rubric, url: url, note: note,
        important: !!d.important, authorName: authorName,
        createdAt: now_(), status: 'new', token: token
      });
      return { id: id, token: token };
    }

    case 'setReqUrl': {
      const r = getReq_(b.rid);
      checkToken_(r, b);
      if (r.status !== 'new' && r.status !== 'accepted') throw new Error('Эту заявку уже нельзя менять');
      const url = str_(b.url, 500).trim();
      if (!url) throw new Error('Вставь ссылку или слаг');
      r.edits = (r.edits || []).concat([{ at: now_(), from: r.url || '', to: url }]).slice(-30);
      r.url = url;
      r.urlUpdatedAt = now_();
      put_('requests', b.rid, r);
      return {};
    }

    case 'withdraw': {
      const r = getReq_(b.rid);
      checkToken_(r, b);
      if (r.status !== 'new') throw new Error('Отозвать можно только заявку на рассмотрении');
      r.status = 'withdrawn';
      r.decidedAt = now_();
      put_('requests', b.rid, r);
      return {};
    }

    case 'accept': {
      needMod_(b);
      const r = getReq_(b.rid);
      const id = cellId_(r.date, r.col);
      const old = all_('grid')[id] || {};
      put_('grid', id, {
        date: r.date, col: r.col, state: r.url ? 'set' : 'held',
        rubric: r.rubric || '', url: r.url || '', note: r.url ? '' : str_(r.note, 200),
        important: !!r.important, fixed: !!old.fixed, pinned: false,
        requestId: b.rid, authorName: r.authorName || '', updatedAt: now_()
      });
      r.status = 'accepted';
      r.decidedAt = now_();
      r.reply = str_(b.reply, 500);
      put_('requests', b.rid, r);
      return {};
    }

    case 'reject': {
      needMod_(b);
      const r = getReq_(b.rid);
      r.status = 'rejected';
      r.decidedAt = now_();
      r.reply = str_(b.reply, 500);
      put_('requests', b.rid, r);
      return {};
    }

    case 'applyUrl': {
      needMod_(b);
      const r = getReq_(b.rid);
      const id = cellId_(r.date, r.col);
      const g = all_('grid')[id];
      if (!g) throw new Error('Слот уже свободен');
      g.url = r.url;
      g.state = 'set';
      g.note = '';
      g.updatedAt = now_();
      put_('grid', id, g);
      return {};
    }

    case 'saveCell': {
      needMod_(b);
      const d = b.doc || {};
      const id = cellId_(d.date, d.col);
      const old = all_('grid')[id] || {};
      const url = str_(d.url, 500).trim();
      put_('grid', id, Object.assign(old, {
        date: d.date, col: d.col,
        rubric: str_(d.rubric, 80), url: url, note: str_(d.note, 500),
        state: url ? 'set' : 'held',
        fixed: !!d.fixed, pinned: !!d.pinned, updatedAt: now_()
      }));
      return {};
    }

    case 'free': {
      needMod_(b);
      const parts = String(b.id || '').split('_');
      del_('grid', cellId_(parts[0], parts[1]));
      return {};
    }

    default:
      throw new Error('Неизвестное действие');
  }
}

/* ---------- проверки ---------- */

function needMod_(b) {
  const pass = PropertiesService.getScriptProperties().getProperty('MOD_PASSWORD');
  if (!pass) throw new Error('Пароль модератора не задан в свойствах скрипта');
  if (String(b.password || '') !== pass) throw new Error('Неверный пароль');
}

function checkToken_(r, b) {
  if (!b.token || b.token !== r.token) throw new Error('Менять заявку может только ее автор');
}

function cellId_(date, col) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || COLS.indexOf(col) < 0) throw new Error('Неверный слот');
  return date + '_' + col;
}

function getReq_(id) {
  const r = all_('requests')[String(id || '')];
  if (!r) throw new Error('Заявка не найдена');
  return r;
}

function rubricLoad_(rubric, date) {
  const m = String(date).slice(0, 7);
  const grid = all_('grid');
  const reqs = all_('requests');
  let n = 0;
  for (const k in grid) if (grid[k].rubric === rubric && String(grid[k].date).slice(0, 7) === m) n++;
  for (const k in reqs) if (reqs[k].status === 'new' && reqs[k].rubric === rubric && String(reqs[k].date).slice(0, 7) === m) n++;
  return n;
}

/* ---------- хранилище: лист с колонками id | data (JSON) ---------- */

function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange('A:B').setNumberFormat('@');
    sh.appendRow(['id', 'data']);
  }
  return sh;
}

function all_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const id = values[i][0];
    if (!id) continue;
    try { out[id] = JSON.parse(values[i][1]); } catch (_) {}
  }
  return out;
}

function put_(name, id, obj) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  const ids = last ? sh.getRange(1, 1, last, 1).getValues() : [];
  for (let i = 1; i < ids.length; i++) {
    if (String(ids[i][0]) === id) {
      sh.getRange(i + 1, 2).setValue(JSON.stringify(obj));
      return;
    }
  }
  sh.appendRow([id, JSON.stringify(obj)]);
}

function del_(name, id) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  const ids = last ? sh.getRange(1, 1, last, 1).getValues() : [];
  for (let i = ids.length - 1; i >= 1; i--) {
    if (String(ids[i][0]) === id) sh.deleteRow(i + 1);
  }
}

function state_() {
  const requests = all_('requests');
  for (const k in requests) delete requests[k].token; // токены авторов наружу не отдаем
  return { grid: all_('grid'), requests: requests };
}

function now_() {
  return new Date().toISOString();
}

function str_(s, n) {
  return String(s == null ? '' : s).slice(0, n || 500);
}
