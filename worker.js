const ROOT_FOLDER_ID = '1ejSanhn9oBihnQ87rkpzP6ExAYFrVq6z';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_TEXT = 7000;
const MAX_GROUNDING_SOURCES = 6;
const GEMINI_MODELS = ['gemini-3.6-flash'];

let driveTokenCache = { token: '', expiresAt: 0 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      if (url.pathname === '/health' || url.pathname === '/api/status') {
        const driveConfigured = Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const geminiConfigured = Boolean(env.GEMINI_API_KEY);
        let driveOk = false;
        let driveMessage = 'غير مضبوط';

        if (driveConfigured) {
          try {
            const token = await getDriveAccessToken(env);
            const items = await listDriveFolder(token, ROOT_FOLDER_ID, 1);
            driveOk = true;
            driveMessage = items.files?.length ? 'متصل' : 'متصل — المجلد فارغ أو لا تظهر عناصر';
          } catch (e) {
            driveMessage = safeError(e);
          }
        }

        return json({
          ok: geminiConfigured && driveOk,
          gemini: geminiConfigured,
          drive: driveOk,
          driveMessage,
          rootFolderId: ROOT_FOLDER_ID,
          version: '3.0'
        });
      }

      if (url.pathname === '/api/library' && request.method === 'GET') {
        requireSecret(env.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON');
        const folderId = url.searchParams.get('folder') || ROOT_FOLDER_ID;
        const token = await getDriveAccessToken(env);
        const result = await listDriveFolder(token, folderId, 100);
        return json({ ok: true, folderId, files: normalizeDriveFiles(result.files || []) });
      }

      if (url.pathname === '/api/search' && request.method === 'GET') {
        requireSecret(env.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON');
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ ok: true, files: [] });
        const token = await getDriveAccessToken(env);
        const files = await searchDrive(token, q, 20);
        return json({ ok: true, files: normalizeDriveFiles(files) });
      }

      if (url.pathname === '/api/chat' && request.method === 'POST') {
        requireSecret(env.GEMINI_API_KEY, 'GEMINI_API_KEY');
        requireSecret(env.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON');

        const body = await request.json();
        const message = String(body?.message || '').trim();
        const history = Array.isArray(body?.history) ? body.history.slice(-10) : [];
        if (!message) return json({ ok: false, error: 'السؤال فارغ.' }, 400);

        const token = await getDriveAccessToken(env);
        const candidates = await searchDrive(token, message, 12);
        const sources = await prepareGroundingSources(token, candidates, message);

        const prompt = buildLegalPrompt(message, history, sources);
        const gemini = await callGemini(env, [{ text: prompt }]);

        return json({
          ok: true,
          answer: gemini.text,
          model: gemini.model,
          sources: sources.map((s, i) => ({
            number: i + 1,
            id: s.id,
            name: s.name,
            mimeType: s.mimeType,
            modifiedTime: s.modifiedTime || null,
            webViewLink: s.webViewLink || null,
            status: classifySource(s)
          }))
        });
      }

      if (url.pathname === '/api/analyze-file' && request.method === 'POST') {
        requireSecret(env.GEMINI_API_KEY, 'GEMINI_API_KEY');
        const form = await request.formData();
        const file = form.get('file');
        const question = String(form.get('question') || 'حلّل هذا الملف تحليلاً قضائياً شرعياً منظماً، واستخرج الوقائع والطلبات والبينات والنقاط القانونية، واذكر ما يحتاج إلى تحقق إضافي.').trim();

        if (!(file instanceof File)) return json({ ok: false, error: 'لم يتم اختيار ملف.' }, 400);
        if (file.size > MAX_UPLOAD_BYTES) return json({ ok: false, error: 'حجم الملف كبير. الحد الحالي 8 ميغابايت.' }, 413);

        const bytes = new Uint8Array(await file.arrayBuffer());
        const data = bytesToBase64(bytes);
        const mime = file.type || guessMime(file.name);

        const instruction = [
          'أنت المساعد القضائي الشرعي – غزة.',
          'حلّل الملف المرفق فقط وفق ما يظهر فيه، ولا تخترع وقائع أو مواد قانونية غير موجودة.',
          'إذا احتجت مرجعاً من المكتبة القضائية فاذكر أن ذلك يحتاج بحثاً منفصلاً.',
          'نظّم الإجابة إلى: ملخص، الوقائع، الطلبات، البينات/المستندات، المسائل القانونية، الملاحظات الإجرائية، نقاط تحتاج تحقق، ثم خلاصة بحثية غير ملزمة.',
          'المخرجات للبحث والدراسة ولا تعد رأياً قضائياً رسمياً.',
          '',
          'طلب المستخدم: ' + question
        ].join('\n');

        const gemini = await callGemini(env, [
          { text: instruction },
          { inlineData: { mimeType: mime, data } }
        ]);

        return json({ ok: true, answer: gemini.text, model: gemini.model, fileName: file.name });
      }

      if (url.pathname.startsWith('/api/')) {
        return json({ ok: false, error: 'المسار غير موجود.' }, 404);
      }

      return new Response(HTML, {
        headers: {
          'content-type': 'text/html; charset=UTF-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'strict-origin-when-cross-origin'
        }
      });
    } catch (e) {
      return json({ ok: false, error: safeError(e) }, 500);
    }
  }
};

function requireSecret(value, name) {
  if (!value) throw new Error('المتغير السري ' + name + ' غير موجود في Cloudflare.');
}

function cors(response) {
  const h = new Headers(response.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  h.set('access-control-allow-headers', 'content-type');
  return new Response(response.body, { status: response.status, headers: h });
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' }
  }));
}

function safeError(e) {
  const msg = String(e?.message || e || 'خطأ غير معروف');
  return msg.replace(/AIza[0-9A-Za-z_-]+/g, '[مفتاح مخفي]').slice(0, 1000);
}

async function getDriveAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (driveTokenCache.token && driveTokenCache.expiresAt > now + 120) return driveTokenCache.token;

  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON ليس JSON صالحاً.');
  }

  if (!sa.client_email || !sa.private_key) throw new Error('بيانات حساب خدمة Google ناقصة.');

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const unsigned = base64UrlText(JSON.stringify(header)) + '.' + base64UrlText(JSON.stringify(claims));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + '.' + base64UrlBytes(new Uint8Array(signature));

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('تعذر تسجيل الدخول إلى Google Drive: ' + (data.error_description || data.error || res.status));

  driveTokenCache = {
    token: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600)
  };
  return data.access_token;
}

function pemToArrayBuffer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlText(text) {
  return base64UrlBytes(new TextEncoder().encode(text));
}

function base64UrlBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function driveFetch(token, path, options = {}) {
  const res = await fetch('https://www.googleapis.com' + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      authorization: 'Bearer ' + token
    }
  });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text(); }
    throw new Error('Google Drive API (' + res.status + '): ' + detail.slice(0, 600));
  }
  return res;
}

async function listDriveFolder(token, folderId, pageSize = 100) {
  const p = new URLSearchParams({
    q: "'" + escapeDriveQuery(folderId) + "' in parents and trashed=false",
    pageSize: String(pageSize),
    orderBy: 'folder,name_natural',
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,parents,description),nextPageToken',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  const res = await driveFetch(token, '/drive/v3/files?' + p.toString());
  return res.json();
}

async function searchDrive(token, query, pageSize = 20) {
  const tokens = meaningfulTokens(query).slice(0, 6);
  if (!tokens.length) return [];

  const parts = [];
  for (const tokenText of tokens) {
    const t = escapeDriveQuery(tokenText);
    parts.push("fullText contains '" + t + "'");
    parts.push("name contains '" + t + "'");
  }
  const q = '(' + parts.join(' or ') + ') and trashed=false';

  const p = new URLSearchParams({
    q,
    pageSize: String(pageSize),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,parents,description)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });

  const res = await driveFetch(token, '/drive/v3/files?' + p.toString());
  const data = await res.json();
  return data.files || [];
}

function meaningfulTokens(text) {
  const stop = new Set(['في','من','على','إلى','الى','عن','ما','هو','هي','هل','مع','هذا','هذه','ذلك','التي','الذي','و','أو','او','ثم','بين','بعد','قبل','عند','لدى','اريد','أريد','معرفة','ماهو','ماهي']);
  return String(text)
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(x => x.length >= 3 && !stop.has(x))
    .filter((x, i, a) => a.indexOf(x) === i);
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeDriveFiles(files) {
  return files.map(f => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime || null,
    size: f.size ? Number(f.size) : null,
    webViewLink: f.webViewLink || null,
    isFolder: f.mimeType === DRIVE_FOLDER_MIME,
    description: f.description || ''
  }));
}

async function prepareGroundingSources(token, files, query) {
  const ranked = rankFiles(files, query).slice(0, MAX_GROUNDING_SOURCES);
  const out = [];

  for (const f of ranked) {
    const item = { ...f, text: '', inlinePart: null };
    try {
      if (f.mimeType === 'application/vnd.google-apps.document') {
        item.text = (await exportGoogleFile(token, f.id, 'text/plain')).slice(0, MAX_SOURCE_TEXT);
      } else if (f.mimeType === 'application/vnd.google-apps.spreadsheet') {
        item.text = (await exportGoogleFile(token, f.id, 'text/csv')).slice(0, MAX_SOURCE_TEXT);
      } else if (isTextMime(f.mimeType, f.name)) {
        item.text = (await downloadTextFile(token, f.id)).slice(0, MAX_SOURCE_TEXT);
      }
    } catch {
      item.text = '';
    }
    out.push(item);
  }
  return out;
}

function rankFiles(files, query) {
  const qTokens = meaningfulTokens(query);
  return [...files].sort((a, b) => scoreFile(b, qTokens) - scoreFile(a, qTokens));
}

function scoreFile(f, tokens) {
  const n = String(f.name || '').toLowerCase();
  let score = 0;
  for (const t of tokens) if (n.includes(t.toLowerCase())) score += 5;
  if (f.mimeType === 'application/vnd.google-apps.document') score += 4;
  if (isTextMime(f.mimeType, f.name)) score += 3;
  if (/فهرس|سجل|قانون|تشريع|حكم|تعميم|مواريث|وصايا/.test(n)) score += 2;
  if (/أصل|اصلية|أصلية|original/.test(n)) score += 2;
  return score;
}

function isTextMime(mime, name) {
  if (String(mime || '').startsWith('text/')) return true;
  if (['application/json','application/xml','application/javascript'].includes(mime)) return true;
  return /\.(txt|md|csv|json|xml|html?)$/i.test(String(name || ''));
}

async function exportGoogleFile(token, id, mimeType) {
  const path = '/drive/v3/files/' + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent(mimeType);
  const res = await driveFetch(token, path);
  return res.text();
}

async function downloadTextFile(token, id) {
  const res = await driveFetch(token, '/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true');
  return res.text();
}

function classifySource(s) {
  const n = String(s.name || '');
  if (/ORIGINAL_VERIFIED|أصلية|اصلية|أصلي|اصل موثق|موثّق/.test(n)) return 'أصل/موثّق بحسب تسمية المصدر';
  if (/SECONDARY_LEAD|ثانوي|مرجع ثانوي|دليل بحث/.test(n)) return 'مرجع ثانوي/دليل بحث';
  return 'مصدر من المكتبة — يحتاج قراءة وصفه للتحقق من درجته';
}

function buildLegalPrompt(message, history, sources) {
  const sourceBlocks = sources.map((s, i) => {
    const header = '[S' + (i + 1) + '] ' + s.name + '\n' +
      'معرف الملف: ' + s.id + '\n' +
      'نوعه: ' + s.mimeType + '\n' +
      'حالته الأولية: ' + classifySource(s) + '\n';
    const body = s.text ? ('مقتطف من المحتوى:\n' + s.text) : 'لم يتم استخراج نص من هذا الملف في هذه العملية؛ لا تنسب إليه حكماً تفصيلياً إلا إذا كان الاسم وحده يكفي لتحديده.';
    return header + body;
  }).join('\n\n----------------\n\n');

  const historyText = history.map(h => {
    const role = h.role === 'assistant' ? 'المساعد' : 'المستخدم';
    return role + ': ' + String(h.text || '').slice(0, 1500);
  }).join('\n');

  return [
    'أنت «المساعد القضائي الشرعي – غزة»، مساعد بحث وتحليل متخصص في القضاء الشرعي والمحاكم الشرعية في قطاع غزة – فلسطين.',
    'قواعد إلزامية:',
    '1) اعتمد أولاً على المصادر المرفقة من المكتبة القضائية. لا تخترع قانوناً أو مادة أو حكماً أو رقم قضية.',
    '2) كل معلومة مستندة إلى مصدر يجب أن تشير إليها بصيغة [S1] أو [S2] بحسب المصدر.',
    '3) إذا لم تكف المصادر للإجابة، قل بوضوح إن المصادر المسترجعة لا تكفي، وبيّن ما الذي يحتاج بحثاً أو تحققاً.',
    '4) ميّز بين النص الأصلي/الموثق، والفهرس، والمرجع الثانوي، ولا ترفع المرجع الثانوي إلى مرتبة الأصل.',
    '5) لا تنسب إلى تشريع فلسطيني مادة أو نصاً لم يظهر في المصدر المسترجع.',
    '6) في مسائل المواريث: اذكر الفروض والورثة المؤثرين وموانع الإرث والافتراضات، ولا تجزم بالقسمة إذا كانت بيانات الورثة ناقصة.',
    '7) في تحليل الأحكام: فرّق بين الوقائع، الطلبات، البينات، المسألة القانونية، التسبيب، والمنطوق.',
    '8) اختم بتنبيه مختصر: هذه مساعدة بحثية وليست رأياً قضائياً رسمياً.',
    '9) اكتب بالعربية الواضحة، ويمكن استخدام عناوين قصيرة ونقاط مرتبة.',
    '',
    'سياق المحادثة السابق:',
    historyText || 'لا يوجد.',
    '',
    'مصادر مسترجعة من Google Drive:',
    sourceBlocks || 'لم يتم العثور على مصادر مطابقة.',
    '',
    'سؤال المستخدم:',
    message,
    '',
    'أجب اعتماداً على ما سبق، ثم أضف في النهاية عنوان «المصادر المستخدمة» واكتب أسماء المصادر التي استندت إليها فقط.'
  ].join('\n');
}

async function callGemini(env, parts) {
  let lastError = 'تعذر الاتصال بـ Gemini.';

  for (const model of GEMINI_MODELS) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 4096
        }
      })
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n').trim();
      if (!text) throw new Error('Gemini أعاد استجابة فارغة.');
      return { text, model };
    }

    lastError = data?.error?.message || ('Gemini HTTP ' + res.status);
    if (![404, 429, 503].includes(res.status)) break;
  }

  throw new Error('تعذر إكمال الطلب عبر Gemini: ' + lastError);
}

function guessMime(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.md')) return 'text/markdown';
  if (n.endsWith('.csv')) return 'text/csv';
  if (n.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

const HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b746d">
<title>المساعد القضائي الشرعي – غزة</title>
<style>
:root{--teal:#0f8178;--teal2:#0b6661;--ink:#153444;--muted:#6f808a;--line:#dce7ea;--bg:#f2f7f8;--gold:#c79b43;--danger:#c96d27;--shadow:0 12px 32px rgba(31,70,82,.10);--r:20px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Tahoma,Arial,"Segoe UI",sans-serif;background:linear-gradient(180deg,#f8fbfc,#eef5f7);color:var(--ink);min-height:100vh}button,input,textarea{font:inherit}button{cursor:pointer}.hidden{display:none!important}
.hero{background:linear-gradient(90deg,rgba(255,255,255,.97),rgba(236,248,250,.88),rgba(190,222,226,.74));border-bottom:1px solid #d7e4e7;overflow:hidden}.hero-inner{max-width:1480px;margin:auto;padding:22px 24px;display:grid;grid-template-columns:280px 1fr 230px;gap:20px;align-items:center}.brand{display:flex;gap:14px;align-items:center}.seal{width:94px;height:94px;border:3px solid var(--teal2);border-radius:30px;background:linear-gradient(145deg,#fffdf5,#ead9a8);display:grid;place-items:center;font-size:44px;box-shadow:var(--shadow)}.brand h1{font-size:23px;line-height:1.45;margin:0;color:#0a5b58}.brand p{margin:5px 0;color:#527275;font-weight:700}.verse{text-align:center;color:#10545d}.basmala{font-size:29px;margin-bottom:8px}.verse-text{font-weight:800;font-size:24px;line-height:1.8}.verse-ref{font-size:17px;font-weight:900}.flag-card{min-height:150px;border-radius:20px;background:linear-gradient(180deg,#0a5e5a,#0f887f);color:#fff;display:grid;place-items:center;text-align:center;padding:12px;box-shadow:var(--shadow)}.flag{width:110px;height:56px;border-radius:7px;overflow:hidden;position:relative;box-shadow:0 5px 14px #0002}.flag div{height:33.333%}.black{background:#111}.white{background:#fff}.green{background:#0c7a49}.flag:before{content:"";position:absolute;left:0;top:0;border-top:28px solid transparent;border-bottom:28px solid transparent;border-right:42px solid #ce2634}.flag-card strong{font-size:18px;line-height:1.5}
.topbar{max-width:1480px;margin:auto;padding:9px 24px;display:grid;grid-template-columns:280px 1fr 280px;gap:12px;background:#fff;border-bottom:1px solid var(--line);position:relative;z-index:5}.topbox{height:56px;border:1px solid var(--line);border-radius:15px;background:#fff;display:flex;align-items:center;gap:10px;padding:0 14px}.topbox input{border:0;outline:0;width:100%;background:transparent}.profile strong{display:block;font-size:13px}.profile small{color:var(--muted)}.dot{width:10px;height:10px;border-radius:50%;background:#aaa}.dot.ok{background:#17a56d}.dot.bad{background:#d15b4a}
.shell{max-width:1480px;margin:auto;padding:12px 24px 30px;display:grid;grid-template-columns:270px minmax(0,1fr) 280px;gap:15px;align-items:start}.panel{background:#fff;border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}.left{padding:10px;position:sticky;top:10px}.nav{width:100%;height:49px;border:0;border-radius:13px;background:transparent;color:#193b4b;display:flex;align-items:center;gap:11px;padding:0 13px;font-weight:800;margin:3px 0;text-align:right}.nav:hover,.nav.active{background:linear-gradient(90deg,var(--teal),#0d9388);color:#fff}.divider{height:1px;background:var(--line);margin:12px 6px}.section-title{font-weight:900;margin:8px 8px 4px}.recent{padding:8px 10px;border-radius:11px}.recent:hover{background:#f3f8f8}.recent strong{display:block;font-size:13px}.recent small{color:var(--muted)}.aqsa{margin-top:14px;min-height:165px;border-radius:17px;background:linear-gradient(145deg,#e1eff3,#cddfe1);display:flex;align-items:flex-end;justify-content:center;text-align:center;padding:18px;font-size:24px;font-weight:900;color:#0b625d}.main{min-width:0}.intro{padding:18px 20px;text-align:center;margin-bottom:12px}.intro h2{margin:0 0 6px}.intro p{margin:5px auto;max-width:760px;line-height:1.8}.quick-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}.quick{border:1px solid var(--line);border-radius:17px;background:#fff;min-height:112px;padding:12px 8px;font-weight:900;color:#244654}.quick span{display:block;font-size:29px;margin-bottom:8px}.quick:hover{transform:translateY(-1px);box-shadow:var(--shadow)}.chat{padding:15px;min-height:490px;max-height:62vh;overflow:auto;display:flex;flex-direction:column;gap:12px}.bubble{max-width:88%;padding:14px 16px;border-radius:18px;line-height:1.9;border:1px solid #dce7ea;white-space:normal;word-wrap:break-word}.bubble.user{align-self:flex-start;background:#e7f2fb}.bubble.bot{align-self:flex-end;background:#edf8ef}.bubble.error{background:#fff3ed;border-color:#efc5b3}.meta{margin-top:8px;font-size:11px;color:#6f818b}.source-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.source-chip{font-size:12px;border:1px solid #bfd9d5;background:#fff;border-radius:999px;padding:5px 9px;color:#175c5a;text-decoration:none}.msg-actions{display:flex;gap:8px;margin-top:10px}.msg-actions button{border:1px solid var(--line);background:#fff;border-radius:10px;padding:6px 9px}.composer{margin-top:12px;padding:10px;display:grid;grid-template-columns:44px 1fr 58px;gap:9px;align-items:end}.composer textarea{height:58px;max-height:140px;resize:vertical;border:1px solid var(--line);border-radius:15px;padding:15px;outline:none}.iconbtn{height:54px;border:0;border-radius:14px;background:#f2f6f7;color:#31505d;font-size:22px}.send{height:54px;border:0;border-radius:15px;background:linear-gradient(135deg,#0e8b82,#087169);color:white;font-size:25px}.right{display:flex;flex-direction:column;gap:12px}.sidebox{padding:14px}.sidebox h3{margin:5px 0 12px}.tool{width:100%;min-height:49px;border:1px solid var(--line);border-radius:13px;background:#fff;margin:5px 0;text-align:right;padding:0 12px;font-weight:800}.tool:hover{background:#f5faf9}.warn{color:#7f4d1b}.footer-note{text-align:center;line-height:1.8}.mobile-bottom{display:none}
.statusbar{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0 0;justify-content:center}.pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:5px 9px;background:#fff}.pill.ok{color:#087552;border-color:#bce3d1}.pill.bad{color:#a24a3b;border-color:#efcbc5}
.overlay{position:fixed;inset:0;background:rgba(17,40,46,.42);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:16px;z-index:100}.tribute,.modal{width:min(650px,96vw);max-height:92vh;overflow:auto;background:#fff;border-radius:27px;border:1px solid #d9c18b;box-shadow:0 25px 70px rgba(15,52,61,.28);padding:27px;position:relative}.tribute{text-align:center}.modal{border-color:var(--line)}.close{position:absolute;left:15px;top:14px;width:38px;height:38px;border:0;border-radius:50%;background:#edf3f4;font-size:22px}.seal2{width:110px;height:110px;border:3px solid var(--teal2);border-radius:34px;background:#fffaf0;margin:0 auto 8px;display:grid;place-items:center;font-size:53px}.tag{display:inline-block;padding:8px 28px;border:1px solid #d6b264;border-radius:999px;background:#f6e9c8;color:#8b651f;font-weight:900;margin:10px}.sheikh{font-size:29px;font-weight:900;color:#0b6c65}.kunya{font-size:22px;font-weight:900;color:#986813}.tribute p{line-height:1.9;color:#344e59}.dua{font-size:21px;font-weight:900;color:#0f756f}.enter{width:min(360px,100%);height:55px;border:0;border-radius:16px;background:linear-gradient(90deg,#118f85,#087169);color:#fff;font-weight:900;font-size:18px}.modal h2{margin-top:3px}.results{display:flex;flex-direction:column;gap:8px}.result{border:1px solid var(--line);border-radius:14px;padding:12px;background:#fbfdfd}.result-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.result-name{font-weight:900}.result-meta{font-size:12px;color:var(--muted);margin-top:5px}.result-actions{display:flex;gap:7px;margin-top:8px;flex-wrap:wrap}.smallbtn{border:1px solid var(--line);border-radius:10px;background:#fff;padding:7px 10px}.folderbtn{color:#0a6a64}.empty{text-align:center;color:var(--muted);padding:25px}.loader{display:inline-block;width:18px;height:18px;border:3px solid #cfe1e0;border-top-color:var(--teal);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;left:18px;bottom:20px;background:#173b46;color:#fff;padding:11px 15px;border-radius:12px;z-index:150;box-shadow:var(--shadow);max-width:330px}.case-row{display:flex;justify-content:space-between;gap:10px;align-items:center;border:1px solid var(--line);border-radius:13px;padding:10px;margin:7px 0}.case-row button{border:0;background:transparent}.case-input{width:100%;height:48px;border:1px solid var(--line);border-radius:12px;padding:0 12px;margin:7px 0}
@media(max-width:1100px){.hero-inner{grid-template-columns:230px 1fr}.flag-card{display:none}.shell{grid-template-columns:230px minmax(0,1fr)}.right{display:none}.topbar{grid-template-columns:230px 1fr}.profile{display:none}.quick-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:760px){body{padding-bottom:72px}.hero-inner{grid-template-columns:1fr;padding:14px}.brand{justify-content:center}.seal{width:72px;height:72px;border-radius:23px;font-size:34px}.brand h1{font-size:19px}.verse-text{font-size:17px}.basmala{font-size:22px}.topbar{display:block;padding:8px 10px;position:sticky;top:0;z-index:20}.topbar .datebox,.topbar .profile{display:none}.searchbar{height:50px}.shell{display:block;padding:9px}.left,.right{display:none}.intro{padding:14px}.intro h2{font-size:19px}.quick-grid{grid-template-columns:repeat(2,1fr);gap:8px}.quick{min-height:94px;font-size:13px}.chat{min-height:410px;max-height:none}.bubble{max-width:95%;font-size:14px}.composer{position:sticky;bottom:76px;background:#fff;z-index:10;grid-template-columns:42px 1fr 54px}.composer textarea{height:54px}.mobile-bottom{position:fixed;bottom:0;left:0;right:0;height:68px;background:#fff;border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(5,1fr);z-index:45}.mobile-bottom button{border:0;background:#fff;font-size:12px;color:#173a49}.mobile-bottom button b{display:block;font-size:20px}.overlay{align-items:flex-end;padding:7px}.tribute,.modal{width:100%;border-radius:25px 25px 14px 14px;padding:22px 16px}.sheikh{font-size:24px}.hero{min-height:auto}}
</style>
</head>
<body>
<header class="hero"><div class="hero-inner">
  <div class="brand"><div class="seal">⚖️</div><div><h1>المساعد القضائي الشرعي<br>غزة – فلسطين</h1><p>بالعلم.. تُعلى العدالة</p></div></div>
  <div class="verse"><div class="basmala">بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ</div><div class="verse-text">﴿ إِنَّ اللَّهَ يَأْمُرُكُمْ أَنْ تُؤَدُّوا الْأَمَانَاتِ إِلَىٰ أَهْلِهَا<br>وَإِذَا حَكَمْتُمْ بَيْنَ النَّاسِ أَنْ تَحْكُمُوا بِالْعَدْلِ ﴾</div><div class="verse-ref">[النساء: 58]</div></div>
  <div class="flag-card"><div class="flag"><div class="black"></div><div class="white"></div><div class="green"></div></div><strong>فلسطين<br>أرض الحق<br>وأهل العدالة</strong></div>
</div></header>

<div class="topbar">
  <div class="topbox datebox">📅 <span id="dateText"></span></div>
  <div class="topbox searchbar">🔎 <input id="globalSearch" placeholder="ابحث في المكتبة القضائية..."></div>
  <div class="topbox profile"><span id="statusDot" class="dot"></span><div><small>حالة النظام</small><strong id="statusText">جارٍ الفحص...</strong></div></div>
</div>

<main class="shell">
<aside class="left panel">
  <button class="nav active" data-action="home">⌂ الصفحة الرئيسية</button>
  <button class="nav" data-action="new-chat">💬 محادثة جديدة</button>
  <button class="nav" data-action="cases">📁 إدارة القضايا</button>
  <button class="nav" data-action="upload">📄 رفع ملف</button>
  <button class="nav" data-action="search">🔎 البحث في القوانين</button>
  <button class="nav" data-action="library">📖 الأحكام والتعاميم</button>
  <button class="nav" data-action="inheritance">👥 المواريث والحساب الشرعي</button>
  <button class="nav" data-action="registry">🔖 السجل المرجعي</button>
  <button class="nav" data-action="library">📚 المصادر والمراجع</button>
  <button class="nav" data-action="favorites">☆ المفضلة</button>
  <button class="nav" data-action="settings">⚙ الإعدادات</button>
  <div class="divider"></div><div class="section-title">آخر المحادثات</div><div id="recentList"></div>
  <div class="aqsa">القدس<br>في قلوبنا دائماً</div>
</aside>

<section class="main">
  <div class="intro panel"><h2>السلام عليكم ورحمة الله وبركاته</h2><p><strong>أنا المساعد القضائي الشرعي – غزة.</strong></p><p>مساعدك القانوني والبحثي المتخصص في القضاء الشرعي والمحاكم الشرعية في قطاع غزة – فلسطين. أبحث في مكتبتك القضائية المتصلة بـ Google Drive وأعرض المصادر المسترجعة مع الإجابة.</p><div class="statusbar"><span class="pill" id="drivePill">Drive: فحص...</span><span class="pill" id="geminiPill">Gemini: فحص...</span></div></div>
  <div class="quick-grid">
    <button class="quick" data-action="search"><span>📚</span>ابحث في القوانين</button>
    <button class="quick" data-action="upload"><span>📄</span>ارفع ملف لتحليله</button>
    <button class="quick" data-action="inheritance"><span>⚖️</span>حل مسألة مواريث</button>
    <button class="quick" data-action="new-case"><span>📂</span>ابدأ قضية جديدة</button>
  </div>
  <div class="chat panel" id="chatBox"></div>
  <div class="composer panel"><button class="iconbtn" id="attachBtn" title="رفع ملف">📎</button><textarea id="messageInput" placeholder="اكتب سؤالك هنا..."></textarea><button class="send" id="sendBtn">➤</button></div>
  <input type="file" id="fileInput" class="hidden" accept=".pdf,.txt,.md,.csv,.json,image/*">
</section>

<aside class="right">
  <div class="sidebox panel"><h3>أدوات سريعة</h3><button class="tool" data-action="search">🔎 بحث شامل</button><button class="tool" data-action="upload">📄 رفع ملف</button><button class="tool" data-action="inheritance">🧮 حساب المواريث</button><button class="tool" data-action="judgment">⚖️ تحليل حكم</button><button class="tool" data-action="library">📖 عرض التعاميم</button><button class="tool" data-action="registry">🔖 المصادر والمراجع</button></div>
  <div class="sidebox panel"><h3>ℹ️ معلومات المشروع</h3><p>يعتمد المساعد على مكتبة قانونية وقضائية خاصة بالمحاكم الشرعية في قطاع غزة، مع محاولة الاستناد إلى المصادر المسترجعة وعدم اختراع مراجع غير متاحة.</p></div>
  <div class="sidebox panel warn"><h3>⚠️ تنبيه</h3><p>المخرجات مقدمة لأغراض البحث والدراسة والمراجعة، ولا تعد بديلاً عن الرأي القضائي الرسمي.</p></div>
  <div class="sidebox panel footer-note"><strong>إنشاء وتطوير</strong><br>عبد الرحمن محمد الحليمي<br><br>النسخة 3.0<br>2026</div>
</aside>
</main>

<nav class="mobile-bottom"><button data-action="home"><b>⌂</b>الرئيسية</button><button data-action="new-chat"><b>💬</b>محادثة</button><button data-action="upload"><b>📄</b>رفع ملف</button><button data-action="search"><b>🔎</b>بحث</button><button data-action="library"><b>☰</b>المزيد</button></nav>

<div class="overlay" id="welcomeOverlay"><div class="tribute"><button class="close" data-close="welcomeOverlay">×</button><div class="seal2">⚖️</div><h2>المساعد القضائي الشرعي<br>غزة – فلسطين</h2><div class="tag">إهداء وتقدير</div><div>إلى فضيلة الشيخ</div><div class="sheikh">محمد خليل الحليمي</div><div class="kunya">«أبو عبد الرحمن»</div><p>عرفاناً بجهودكم المباركة في خدمة العلم الشرعي والقضاء والناس، وتقديراً لمسيرتكم في نصرة الحق والعدل، أُهدي إليكم هذا العمل المتواضع.</p><div class="dua">✦ دعاء ✦</div><p>اللهم احفظ فضيلة الشيخ محمد خليل الحليمي، وأطل في عمره على طاعتك، وبارك له في علمه وعمله وأهله، واجعل ما قدّمه في ميزان حسناته، واكتب له الأجر والقبول، وألبسه ثوب الصحة والعافية، واجعله ذخراً للعلم والعدل والإسلام والمسلمين.</p><button class="enter" id="enterBtn">دخول إلى المساعد ←</button><p style="font-size:12px">إن أصبنا فمن الله، وإن أخطأنا فمن أنفسنا.<br>عبد الرحمن محمد الحليمي</p></div></div>

<div class="overlay hidden" id="modalOverlay"><div class="modal"><button class="close" data-close="modalOverlay">×</button><h2 id="modalTitle">المكتبة القضائية</h2><div id="modalBody"></div></div></div>
<div class="toast hidden" id="toast"></div>

<script>
(function(){
  var ROOT = '1ejSanhn9oBihnQ87rkpzP6ExAYFrVq6z';
  var chatBox = document.getElementById('chatBox');
  var input = document.getElementById('messageInput');
  var sendBtn = document.getElementById('sendBtn');
  var fileInput = document.getElementById('fileInput');
  var modal = document.getElementById('modalOverlay');
  var modalTitle = document.getElementById('modalTitle');
  var modalBody = document.getElementById('modalBody');
  var toast = document.getElementById('toast');
  var currentCaseId = localStorage.getItem('sj_current_case') || '';
  var history = [];

  function escapeHtml(s){return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function linkifyMarkdown(text){
    var s = escapeHtml(text);
    s = s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
    s = s.replace(/^###\s+(.+)$/gm,'<h4>$1</h4>');
    s = s.replace(/^##\s+(.+)$/gm,'<h3>$1</h3>');
    s = s.replace(/^#\s+(.+)$/gm,'<h3>$1</h3>');
    s = s.replace(/^\s*[-•]\s+(.+)$/gm,'<div>• $1</div>');
    s = s.replace(/^\s*(\d+)\.\s+(.+)$/gm,'<div>$1. $2</div>');
    return s.replace(/\n/g,'<br>');
  }
  function showToast(msg){toast.textContent=msg;toast.classList.remove('hidden');setTimeout(function(){toast.classList.add('hidden');},2600);}
  function openModal(title, html){modalTitle.textContent=title;modalBody.innerHTML=html;modal.classList.remove('hidden');}
  function closeModal(){modal.classList.add('hidden');}
  document.querySelectorAll('[data-close]').forEach(function(b){b.onclick=function(){document.getElementById(b.getAttribute('data-close')).classList.add('hidden');};});
  document.getElementById('enterBtn').onclick=function(){document.getElementById('welcomeOverlay').classList.add('hidden');};

  function addMessage(role, text, sources, meta){
    var d=document.createElement('div');d.className='bubble '+(role==='user'?'user':'bot');
    d.innerHTML=linkifyMarkdown(text);
    if(meta){var m=document.createElement('div');m.className='meta';m.textContent=meta;d.appendChild(m);}
    if(sources&&sources.length){var sc=document.createElement('div');sc.className='source-chips';sources.forEach(function(s){var a=document.createElement(s.webViewLink?'a':'span');a.className='source-chip';a.textContent='[S'+s.number+'] '+s.name;if(s.webViewLink){a.href=s.webViewLink;a.target='_blank';a.rel='noopener';}sc.appendChild(a);});d.appendChild(sc);}
    if(role==='assistant'){
      var actions=document.createElement('div');actions.className='msg-actions';
      var cp=document.createElement('button');cp.textContent='نسخ';cp.onclick=function(){navigator.clipboard.writeText(text);showToast('تم النسخ');};actions.appendChild(cp);
      var fav=document.createElement('button');fav.textContent='☆ حفظ';fav.onclick=function(){saveFavorite(text,sources||[]);};actions.appendChild(fav);d.appendChild(actions);
    }
    chatBox.appendChild(d);chatBox.scrollTop=chatBox.scrollHeight;
    return d;
  }

  function showTyping(){var d=document.createElement('div');d.className='bubble bot';d.id='typing';d.innerHTML='<span class="loader"></span> جارٍ البحث في المكتبة وتحليل السؤال...';chatBox.appendChild(d);chatBox.scrollTop=chatBox.scrollHeight;}
  function hideTyping(){var e=document.getElementById('typing');if(e)e.remove();}

  async function api(path, options){var r=await fetch(path,options||{});var data=await r.json().catch(function(){return {ok:false,error:'استجابة غير صالحة'};});if(!r.ok||data.ok===false)throw new Error(data.error||('HTTP '+r.status));return data;}

  async function sendMessage(prefill){
    var message=(prefill||input.value).trim();if(!message)return;input.value='';addMessage('user',message);history.push({role:'user',text:message});history=history.slice(-10);saveChatLocal();showTyping();sendBtn.disabled=true;
    try{
      var data=await api('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:message,history:history})});hideTyping();addMessage('assistant',data.answer,data.sources,'النموذج: '+data.model);history.push({role:'assistant',text:data.answer});history=history.slice(-10);saveChatLocal();renderRecent();
    }catch(e){hideTyping();var d=addMessage('assistant','تعذر إكمال الطلب:\n'+e.message);d.classList.add('error');}
    finally{sendBtn.disabled=false;}
  }
  sendBtn.onclick=function(){sendMessage();};input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});

  function storageJSON(key, fallback){try{return JSON.parse(localStorage.getItem(key)||'')||fallback;}catch{return fallback;}}
  function saveChatLocal(){var chats=storageJSON('sj_chats',{});var id=currentCaseId||'general';chats[id]={updatedAt:Date.now(),history:history,title:(history.find(function(x){return x.role==='user';})||{}).text||'محادثة جديدة'};localStorage.setItem('sj_chats',JSON.stringify(chats));}
  function newChat(){history=[];currentCaseId='';localStorage.removeItem('sj_current_case');chatBox.innerHTML='';addMessage('assistant','السلام عليكم ورحمة الله وبركاته. اكتب سؤالك، وسأبحث في المكتبة القضائية المتصلة قبل الإجابة قدر الإمكان.');}
  function renderRecent(){var chats=storageJSON('sj_chats',{});var rows=Object.keys(chats).map(function(k){return {id:k,data:chats[k]};}).sort(function(a,b){return b.data.updatedAt-a.data.updatedAt;}).slice(0,5);document.getElementById('recentList').innerHTML=rows.map(function(r){return '<div class="recent" data-chat="'+escapeHtml(r.id)+'"><strong>'+escapeHtml((r.data.title||'محادثة').slice(0,35))+'</strong><small>'+new Date(r.data.updatedAt).toLocaleDateString('ar-PS')+'</small></div>';}).join('')||'<div class="recent"><small>لا توجد محادثات محفوظة بعد.</small></div>';document.querySelectorAll('[data-chat]').forEach(function(el){el.onclick=function(){loadChat(el.getAttribute('data-chat'));};});}
  function loadChat(id){var chats=storageJSON('sj_chats',{});if(!chats[id])return;history=chats[id].history||[];currentCaseId=id==='general'?'':id;if(currentCaseId)localStorage.setItem('sj_current_case',currentCaseId);chatBox.innerHTML='';history.forEach(function(m){addMessage(m.role,m.text);});}

  function saveFavorite(text,sources){var f=storageJSON('sj_favorites',[]);f.unshift({id:Date.now(),text:text,sources:sources,date:new Date().toISOString()});localStorage.setItem('sj_favorites',JSON.stringify(f.slice(0,100)));showToast('تم الحفظ في المفضلة');}
  function showFavorites(){var f=storageJSON('sj_favorites',[]);openModal('المفضلة',f.length?f.map(function(x){return '<div class="result"><div class="result-name">'+escapeHtml(x.text.slice(0,100))+'</div><div class="result-meta">'+new Date(x.date).toLocaleString('ar-PS')+'</div></div>';}).join(''):'<div class="empty">لا توجد عناصر محفوظة.</div>');}

  async function checkStatus(){try{var s=await api('/api/status');var d=document.getElementById('statusDot');var t=document.getElementById('statusText');d.className='dot '+(s.ok?'ok':'bad');t.textContent=s.ok?'المساعد الذكي متصل':'يحتاج فحص';setPill('drivePill',s.drive,'Drive: '+(s.drive?'متصل':'غير متصل'));setPill('geminiPill',s.gemini,'Gemini: '+(s.gemini?'مضبوط':'غير مضبوط'));}catch(e){document.getElementById('statusText').textContent='تعذر الفحص';}}
  function setPill(id,ok,text){var p=document.getElementById(id);p.textContent=text;p.className='pill '+(ok?'ok':'bad');}

  async function showLibrary(folderId,title){openModal(title||'المكتبة القضائية','<div class="empty"><span class="loader"></span> جارٍ تحميل الملفات...</div>');try{var d=await api('/api/library?folder='+encodeURIComponent(folderId||ROOT));renderDriveResults(d.files||[],true);}catch(e){modalBody.innerHTML='<div class="empty">'+escapeHtml(e.message)+'</div>';}}
  function renderDriveResults(files,foldersClickable){if(!files.length){modalBody.innerHTML='<div class="empty">لا توجد عناصر.</div>';return;}modalBody.innerHTML='<div class="results">'+files.map(function(f){var icon=f.isFolder?'📁':'📄';var btn=f.isFolder?'<button class="smallbtn folderbtn" data-folder="'+f.id+'" data-name="'+escapeHtml(f.name)+'">فتح المجلد</button>':(f.webViewLink?'<a class="smallbtn" target="_blank" rel="noopener" href="'+escapeHtml(f.webViewLink)+'">فتح المصدر</a>':'');return '<div class="result"><div class="result-head"><div><div class="result-name">'+icon+' '+escapeHtml(f.name)+'</div><div class="result-meta">'+escapeHtml(f.mimeType)+(f.modifiedTime?' • '+new Date(f.modifiedTime).toLocaleDateString('ar-PS'):'')+'</div></div></div><div class="result-actions">'+btn+'</div></div>';}).join('')+'</div>';document.querySelectorAll('[data-folder]').forEach(function(b){b.onclick=function(){showLibrary(b.getAttribute('data-folder'),b.getAttribute('data-name'));};});}

  async function searchLibrary(q){q=(q||document.getElementById('globalSearch').value).trim();if(!q){openModal('البحث في المكتبة','<div class="empty">اكتب كلمة البحث أولاً.</div>');return;}openModal('نتائج البحث','<div class="empty"><span class="loader"></span> جارٍ البحث في Google Drive...</div>');try{var d=await api('/api/search?q='+encodeURIComponent(q));renderDriveResults(d.files||[],false);}catch(e){modalBody.innerHTML='<div class="empty">'+escapeHtml(e.message)+'</div>';}}
  document.getElementById('globalSearch').addEventListener('keydown',function(e){if(e.key==='Enter')searchLibrary(e.target.value);});

  document.getElementById('attachBtn').onclick=function(){fileInput.click();};
  fileInput.onchange=async function(){var f=fileInput.files[0];if(!f)return;var q=input.value.trim()||'حلّل هذا الملف تحليلاً قضائياً شرعياً منظماً.';openModal('تحليل الملف','<div class="empty"><span class="loader"></span> جارٍ رفع وتحليل '+escapeHtml(f.name)+'...</div>');var fd=new FormData();fd.append('file',f);fd.append('question',q);try{var d=await api('/api/analyze-file',{method:'POST',body:fd});modalBody.innerHTML='<div class="result"><div class="result-name">'+escapeHtml(f.name)+'</div><div style="line-height:1.9;margin-top:10px">'+linkifyMarkdown(d.answer)+'</div><div class="result-meta">النموذج: '+escapeHtml(d.model)+'</div></div>';addMessage('assistant','تم تحليل الملف «'+f.name+'». افتح نافذة تحليل الملف لرؤية التفاصيل.');}catch(e){modalBody.innerHTML='<div class="empty">'+escapeHtml(e.message)+'</div>';}finally{fileInput.value='';}};

  function casesUI(){var cases=storageJSON('sj_cases',[]);var html='<input class="case-input" id="caseTitle" placeholder="اسم القضية الجديدة"><button class="smallbtn" id="createCaseBtn">إنشاء قضية</button><div class="divider"></div>'+(cases.length?cases.map(function(c){return '<div class="case-row"><div><strong>'+escapeHtml(c.title)+'</strong><div class="result-meta">'+new Date(c.createdAt).toLocaleDateString('ar-PS')+'</div></div><div><button data-open-case="'+c.id+'">فتح</button><button data-delete-case="'+c.id+'">🗑</button></div></div>';}).join(''):'<div class="empty">لا توجد قضايا محفوظة على هذا الجهاز.</div>');openModal('إدارة القضايا',html);setTimeout(bindCases,0);}
  function bindCases(){var c=document.getElementById('createCaseBtn');if(c)c.onclick=function(){var title=(document.getElementById('caseTitle').value||'').trim();if(!title)return;var cases=storageJSON('sj_cases',[]);var id='case_'+Date.now();cases.unshift({id:id,title:title,createdAt:new Date().toISOString()});localStorage.setItem('sj_cases',JSON.stringify(cases));currentCaseId=id;localStorage.setItem('sj_current_case',id);history=[];closeModal();chatBox.innerHTML='';addMessage('assistant','تم فتح القضية: '+title+'\nاكتب الوقائع أو ارفع المستندات للبدء.');renderRecent();};document.querySelectorAll('[data-open-case]').forEach(function(b){b.onclick=function(){currentCaseId=b.getAttribute('data-open-case');localStorage.setItem('sj_current_case',currentCaseId);var chats=storageJSON('sj_chats',{});closeModal();if(chats[currentCaseId])loadChat(currentCaseId);else{history=[];chatBox.innerHTML='';addMessage('assistant','تم فتح ملف القضية. اكتب الوقائع أو السؤال للبدء.');}};});document.querySelectorAll('[data-delete-case]').forEach(function(b){b.onclick=function(){var id=b.getAttribute('data-delete-case');var cases=storageJSON('sj_cases',[]).filter(function(x){return x.id!==id;});localStorage.setItem('sj_cases',JSON.stringify(cases));var chats=storageJSON('sj_chats',{});delete chats[id];localStorage.setItem('sj_chats',JSON.stringify(chats));casesUI();};});}

  function showSettings(){openModal('الإعدادات','<div class="result"><div class="result-name">الخصوصية والحفظ</div><p>المحادثات والقضايا والمفضلة محفوظة محلياً في هذا المتصفح فقط. مكتبة Google Drive تُقرأ من الخادم بصلاحية قراءة فقط.</p><button class="smallbtn" id="clearLocal">مسح بيانات هذا الجهاز</button></div>');setTimeout(function(){var b=document.getElementById('clearLocal');if(b)b.onclick=function(){['sj_chats','sj_cases','sj_favorites','sj_current_case'].forEach(function(k){localStorage.removeItem(k);});newChat();renderRecent();closeModal();showToast('تم مسح البيانات المحلية');};},0);}

  function action(name){if(name==='home'){window.scrollTo({top:0,behavior:'smooth'});}else if(name==='new-chat'){newChat();}else if(name==='cases'||name==='new-case'){casesUI();}else if(name==='upload'){fileInput.click();}else if(name==='search'){searchLibrary();}else if(name==='library'||name==='registry'){showLibrary(ROOT,'المكتبة القضائية');}else if(name==='inheritance'){input.value='أريد حساب مسألة ميراث. بيانات التركة والورثة هي: ';input.focus();}else if(name==='judgment'){input.value='أريد تحليل الحكم التالي مع بيان الوقائع والمسألة القانونية والتسبيب والمنطوق والمصادر: ';input.focus();}else if(name==='favorites'){showFavorites();}else if(name==='settings'){showSettings();}}
  document.querySelectorAll('[data-action]').forEach(function(b){b.onclick=function(){action(b.getAttribute('data-action'));};});

  var now=new Date();document.getElementById('dateText').textContent=now.toLocaleDateString('ar-PS',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  renderRecent();
  var chats=storageJSON('sj_chats',{});var initial=currentCaseId&&chats[currentCaseId]?currentCaseId:(chats.general?'general':'');if(initial)loadChat(initial);else newChat();
  checkStatus();
})();
</script>
</body>
</html>`;
