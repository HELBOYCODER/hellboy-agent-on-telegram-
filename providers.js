/**
 * Provider tooling: model scanning (OpenAI-compatible + Google AI Studio / Gemini),
 * image generation adapters, and the paginated one-button-per-model menus.
 */
import { redisCmd } from "./store.js";
import { tgRequest, getTelegramFileBase64 } from "./worker.js";

export const GEMINI_NATIVE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_OPENAI = "https://generativelanguage.googleapis.com/v1beta/openai";
const PAGE = 8;

export const SIZES = {
  "1:1": { label: "◼️ ۱:۱", openai: "1024x1024" },
  "16:9": { label: "🖼 ۱۶:۹", openai: "1792x1024" },
  "9:16": { label: "📱 ۹:۱۶", openai: "1024x1792" }
};

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const kvGet = (env, k) => redisCmd(env, ["GET", k]);
const kvSet = (env, k, v, ex) => redisCmd(env, ex ? ["SET", k, v, "EX", ex] : ["SET", k, v]);

export const isGemini = (url) => /generativelanguage\.googleapis\.com/.test(url || "");
const trimUrl = (u) => (u || "").trim().replace(/\/+$/, "");

// ==========================================
// Model scanning
// ==========================================
const IMAGE_RE = /(image|imagen|dall-?e|flux|sdxl|stable-?diffusion|sd3|midjourney|recraft|ideogram|nano-?banana|seedream|kolors|playground|veo-?img)/i;
const SKIP_RE = /(embed|tts|whisper|audio|speech|moderation|rerank|transcribe|realtime|aqa|guard|video|veo|lyria|live)/i;
const VISION_RE = /(vision|-vl|vl-|4o|gpt-4|gpt-5|claude|gemini|llava|pixtral|gemma-3|grok|llama-4|\bo[134]\b|multimodal)/i;

export async function scanModels(baseUrl, apiKey) {
  const base = trimUrl(baseUrl);
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 20000);
  try {
    let items = [];
    if (isGemini(base)) {
      let token = "";
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${GEMINI_NATIVE}/models?pageSize=200${token ? `&pageToken=${token}` : ""}`, { headers: { "x-goog-api-key": apiKey }, signal: ctl.signal });
        if (!res.ok) return { items: [], error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
        const d = await res.json();
        for (const m of d.models || []) {
          const id = (m.name || "").replace(/^models\//, "");
          const methods = m.supportedGenerationMethods || [];
          if (SKIP_RE.test(id)) continue;
          if (methods.includes("predict") || (methods.includes("generateContent") && /image/i.test(id))) items.push({ id, kind: "image", vision: false });
          else if (methods.includes("generateContent")) items.push({ id, kind: "chat", vision: true });
        }
        token = d.nextPageToken || "";
        if (!token) break;
      }
    } else {
      const url = base.endsWith("/models") ? base : `${base}/models`;
      const res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: ctl.signal });
      if (!res.ok) return { items: [], error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
      const d = await res.json();
      const list = Array.isArray(d) ? d : (d.data || d.models || []);
      for (const m of list) {
        const id = typeof m === "string" ? m : (m.id || m.name || "");
        if (!id || SKIP_RE.test(id)) continue;
        const caps = JSON.stringify(m.architecture || m.modalities || m.output_modalities || "");
        const isImg = IMAGE_RE.test(id) || /\bimage\b/.test(JSON.stringify(m.output_modalities || m.architecture?.output_modalities || ""));
        items.push({ id, kind: isImg ? "image" : "chat", vision: !isImg && (VISION_RE.test(id) || /image/.test(caps)) });
      }
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    return { items, error: items.length ? null : "هیچ مدلی پیدا نشد" };
  } catch (e) {
    return { items: [], error: e.name === "AbortError" ? "timeout" : e.message };
  } finally { clearTimeout(tm); }
}

// ==========================================
// Image generation
// ==========================================
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** returns { bytes, mime } | { url } | { error } */
export async function generateImage(model, prompt, { size = "1:1", inputImage = null } = {}) {
  const base = trimUrl(model.baseUrl);
  const key = (model.apiKey || "").trim();
  const name = (model.modelName || "").trim();
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 27000);
  try {
    if (base.includes("pollinations.ai")) {
      if (inputImage) return { error: "این سرویس ویرایش عکس ندارد" };
      const dims = size === "16:9" ? "&width=1280&height=720" : size === "9:16" ? "&width=720&height=1280" : "";
      return { url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?model=${encodeURIComponent(name || "flux")}${dims}&nologo=true` };
    }

    if (isGemini(base)) {
      const root = base.replace(/\/openai$/, "");
      if (/imagen/i.test(name)) {
        if (inputImage) return { error: "Imagen ویرایش عکس ندارد؛ از مدل gemini-*-image استفاده کنید" };
        const res = await fetch(`${root}/models/${name}:predict`, {
          method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, signal: ctl.signal,
          body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: size } })
        });
        if (!res.ok) return { error: `Gemini ${res.status}: ${(await res.text()).slice(0, 200)}` };
        const d = await res.json();
        const p = d.predictions?.[0];
        if (!p?.bytesBase64Encoded) return { error: "تصویری برگردانده نشد (ممکن است پرامپت فیلتر شده باشد)" };
        return { bytes: b64ToBytes(p.bytesBase64Encoded), mime: p.mimeType || "image/png" };
      }
      const parts = [{ text: prompt }];
      if (inputImage) parts.push({ inline_data: { mime_type: "image/jpeg", data: inputImage } });
      const call = (withConfig) => fetch(`${root}/models/${name}:generateContent`, {
        method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(withConfig ? { imageConfig: { aspectRatio: size } } : {}) } })
      });
      let res = await call(true);
      if (res.status === 400) res = await call(false);
      if (!res.ok) return { error: `Gemini ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const d = await res.json();
      const outParts = d.candidates?.[0]?.content?.parts || [];
      const img = outParts.find(p => (p.inlineData || p.inline_data)?.data);
      if (!img) {
        const txt = outParts.map(p => p.text).filter(Boolean).join(" ").slice(0, 200);
        return { error: txt || d.promptFeedback?.blockReason || "تصویری برگردانده نشد" };
      }
      const inl = img.inlineData || img.inline_data;
      return { bytes: b64ToBytes(inl.data), mime: inl.mimeType || inl.mime_type || "image/png" };
    }

    if (inputImage) return { error: "ویرایش عکس فقط با مدل‌های Gemini (Google AI Studio) پشتیبانی می‌شود" };
    const endpoint = base.endsWith("/images/generations") ? base : `${base}/images/generations`;
    const call = (withSize) => fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, signal: ctl.signal,
      body: JSON.stringify({ model: name, prompt, n: 1, ...(withSize ? { size: SIZES[size]?.openai || "1024x1024" } : {}) })
    });
    let res = await call(true);
    if (res.status === 400 || res.status === 422) res = await call(false);
    if (!res.ok) return { error: `سرویس تصویر ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const d = await res.json();
    const it = d.data?.[0];
    if (it?.b64_json) return { bytes: b64ToBytes(it.b64_json), mime: "image/png" };
    if (it?.url) return { url: it.url };
    return { error: "پاسخ تصویر نامعتبر بود" };
  } catch (e) {
    return { error: e.name === "AbortError" ? "زمان ساخت تصویر تمام شد (۲۷ ثانیه)" : e.message };
  } finally { clearTimeout(tm); }
}

export async function sendPhotoResult(botToken, chatId, img, caption, replyTo) {
  const cap = String(caption || "").slice(0, 1000);
  if (img.url) {
    const r = await tgRequest(botToken, "sendPhoto", { chat_id: chatId, photo: img.url, caption: cap, ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) });
    if (r.ok) return true;
    try { // Telegram could not fetch it: download and upload ourselves
      const f = await fetch(img.url);
      if (!f.ok) return false;
      img = { bytes: new Uint8Array(await f.arrayBuffer()), mime: f.headers.get("content-type") || "image/jpeg" };
    } catch { return false; }
  }
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new Blob([img.bytes], { type: img.mime || "image/png" }), "image." + ((img.mime || "").includes("jpeg") ? "jpg" : "png"));
    if (cap) form.append("caption", cap);
    if (replyTo) { form.append("reply_to_message_id", String(replyTo)); form.append("allow_sending_without_reply", "true"); }
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: "POST", body: form });
    return !!(await res.json()).ok;
  } catch (e) { console.error("sendPhoto upload error", e); return false; }
}

export async function getImageSelection(env, userId, targetKeyId) {
  const [modelsRaw, a, b, sz] = await Promise.all([
    kvGet(env, "IMAGE_MODELS"), kvGet(env, `USER_IMG_MODEL_${targetKeyId}`), kvGet(env, `USER_IMG_MODEL_${userId}`), kvGet(env, `IMG_SIZE_${targetKeyId}`)
  ]);
  const models = parse(modelsRaw, []);
  let idx = parseInt(a ?? b ?? "0");
  if (isNaN(idx) || !models[idx]) idx = 0;
  return { models, idx, model: models[idx], size: SIZES[sz] ? sz : "1:1" };
}

export async function processImage(botToken, env, chatId, userId, msg, promptText, targetKeyId, replyTo) {
  const sel = await getImageSelection(env, userId, targetKeyId);
  if (!sel.model) {
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "⚠️ هیچ مدل تصویرسازی تعریف نشده. ادمین می‌تواند از «🔍 اسکن پروایدر» در پنل مدیریت مدل اضافه کند." });
    return;
  }
  const st = await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `🎨 در حال ${msg?.photo ? "ویرایش" : "ساخت"} تصویر با ${sel.model.name}...` });
  const statusId = st.result?.message_id;
  await tgRequest(botToken, "sendChatAction", { chat_id: chatId, action: "upload_photo" });

  let inputImage = null;
  if (msg?.photo?.length) inputImage = await getTelegramFileBase64(botToken, msg.photo[msg.photo.length - 1].file_id);
  const prompt = promptText || (inputImage ? "این تصویر را بهتر کن" : "");
  if (!prompt) {
    await tgRequest(botToken, "editMessageText", { chat_id: chatId, message_id: statusId, text: "✍️ توضیح تصویر را بنویس." });
    return;
  }
  const out = await generateImage(sel.model, prompt, { size: sel.size, inputImage });
  const ok = !out.error && await sendPhotoResult(botToken, chatId, out, `✨ ${sel.model.name} · ${sel.size}\n📝 ${prompt}`, replyTo);
  if (ok) { if (statusId) await tgRequest(botToken, "deleteMessage", { chat_id: chatId, message_id: statusId }); }
  else await tgRequest(botToken, "editMessageText", { chat_id: chatId, message_id: statusId, text: `❌ ساخت تصویر ناموفق بود.\n${out.error || "ارسال تصویر به تلگرام شکست خورد."}` });
}

// ==========================================
// Menus (one button per model, paginated)
// ==========================================
function nav(prefix, page, total) {
  const row = [];
  if (page > 0) row.push({ text: "◀️ قبلی", callback_data: `${prefix}${page - 1}` });
  row.push({ text: `${page + 1}/${Math.max(1, Math.ceil(total / PAGE))}`, callback_data: "noop" });
  if ((page + 1) * PAGE < total) row.push({ text: "بعدی ▶️", callback_data: `${prefix}${page + 1}` });
  return total > PAGE ? [row] : [];
}

async function show(botToken, chatId, messageId, text, keyboard) {
  const payload = { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } };
  if (messageId) {
    const r = await tgRequest(botToken, "editMessageText", { ...payload, message_id: messageId });
    if (r.ok || /not modified/i.test(r.description || "")) return;
  }
  await tgRequest(botToken, "sendMessage", payload);
}

export async function sendChatModelMenu(botToken, env, chatId, targetKeyId, page = 0, messageId = null) {
  const [mRaw, cur] = await Promise.all([kvGet(env, "AI_MODELS"), kvGet(env, `USER_MODEL_${targetKeyId}`)]);
  const models = parse(mRaw, []);
  if (!models.length) return show(botToken, chatId, messageId, "⚠️ هیچ مدلی تعریف نشده است.", [[{ text: "🔙 منوی اصلی", callback_data: "main_menu" }]]);
  const curIdx = String(cur ?? "0");
  const kb = models.map((m, i) => ({ m, i })).slice(page * PAGE, page * PAGE + PAGE)
    .map(({ m, i }) => [{ text: `${String(i) === curIdx ? "✅" : "🤖"} ${m.name}${m.supportsVision ? " 👁" : ""}`, callback_data: `set_model_${i}` }]);
  kb.push(...nav("models_pg_", page, models.length));
  kb.push([{ text: "🎨 مدل‌های تصویر", callback_data: "mode_image" }, { text: "🔙 منوی اصلی", callback_data: "main_menu" }]);
  await show(botToken, chatId, messageId, `✨ مدل هوش مصنوعی چت را انتخاب کنید (${models.length} مدل):\nروی هر مدل بزنید تا فعال شود.`, kb);
}

export async function sendImageMenu(botToken, env, chatId, userId, targetKeyId, page = 0, messageId = null, isGroup = false) {
  const sel = await getImageSelection(env, userId, targetKeyId);
  const kb = [Object.entries(SIZES).map(([k, v]) => ({ text: `${sel.size === k ? "✅ " : ""}${v.label}`, callback_data: `img_size_${k}` }))];
  sel.models.map((m, i) => ({ m, i })).slice(page * PAGE, page * PAGE + PAGE)
    .forEach(({ m, i }) => kb.push([{ text: `${i === sel.idx ? "✅" : "🎨"} ${m.name}`, callback_data: `set_img_model_${i}` }]));
  kb.push(...nav("img_pg_", page, sel.models.length));
  kb.push([{ text: "💬 بازگشت به چت", callback_data: "mode_chat" }, ...(isGroup ? [] : [{ text: "🏠 منو", callback_data: "main_menu" }])]);
  const head = sel.models.length
    ? `🎨 *حالت تصویرسازی فعال است*\nمدل: ${sel.model.name}\nنسبت: ${sel.size}\n\nتوضیح تصویر را بنویسید؛ برای ویرایش، عکس را با توضیح بفرستید (مدل‌های Gemini).`
    : "🎨 هنوز مدل تصویری اضافه نشده. ادمین از پنل مدیریت ← «🔍 اسکن پروایدر» اضافه کند.";
  await show(botToken, chatId, messageId, head.replace(/\*/g, ""), kb);
}

// ==========================================
// Admin: provider scan flow
// ==========================================
const norm = (u) => trimUrl(u).replace(/\/openai$/, "");

async function loadScan(env, adminId) { return parse(await kvGet(env, `SCAN_${adminId}`), null); }

export async function sendScanProviders(botToken, env, chatId, messageId = null) {
  const [m, im] = await Promise.all([kvGet(env, "AI_MODELS"), kvGet(env, "IMAGE_MODELS")]);
  const seen = new Map();
  for (const x of [...parse(m, []), ...parse(im, [])]) {
    if (!x.baseUrl) continue;
    const k = norm(x.baseUrl) + "|" + x.apiKey;
    if (!seen.has(k)) seen.set(k, { base: isGemini(x.baseUrl) ? GEMINI_NATIVE : trimUrl(x.baseUrl), key: x.apiKey || "" });
  }
  const provs = [...seen.values()].slice(0, 10);
  await kvSet(env, "SCAN_PROVS", JSON.stringify(provs), 3600);
  const kb = provs.map((p, i) => [{ text: `🔌 ${new URL(p.base).hostname}`, callback_data: `scan_prov_${i}` }]);
  kb.push([{ text: "🟦 Google AI Studio (Gemini)", callback_data: "scan_gemini" }, { text: "➕ پروایدر جدید", callback_data: "scan_new" }]);
  kb.push([{ text: "🔙 پنل مدیریت", callback_data: "admin_panel" }]);
  await show(botToken, chatId, messageId, "🔍 کدام پروایدر اسکن شود؟\n(همه مدل‌های موجود پروایدر خوانده می‌شوند و هر کدام یک دکمه می‌شود)", kb);
}

async function runScan(botToken, env, chatId, adminId, base, key) {
  const st = await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔍 در حال اسکن مدل‌های پروایدر..." });
  const { items, error } = await scanModels(base, key);
  if (error && !items.length) {
    await tgRequest(botToken, "editMessageText", { chat_id: chatId, message_id: st.result?.message_id, text: `❌ اسکن ناموفق: ${error}`, reply_markup: { inline_keyboard: [[{ text: "🔍 تلاش دوباره", callback_data: "admin_scan" }]] } });
    return;
  }
  await kvSet(env, `SCAN_${adminId}`, JSON.stringify({ base, key, items, tab: "chat", page: 0 }), 3600);
  await sendScanPage(botToken, env, chatId, adminId, st.result?.message_id);
}

export async function sendScanPage(botToken, env, chatId, adminId, messageId = null) {
  const sc = await loadScan(env, adminId);
  if (!sc) return show(botToken, chatId, messageId, "⌛ نتیجه اسکن منقضی شد.", [[{ text: "🔍 اسکن مجدد", callback_data: "admin_scan" }]]);
  const [m, im] = await Promise.all([kvGet(env, "AI_MODELS"), kvGet(env, "IMAGE_MODELS")]);
  const have = (list, id) => list.some(x => x.modelName === id && norm(x.baseUrl) === norm(sc.base));
  const chatL = parse(m, []), imgL = parse(im, []);
  const view = sc.items.map((it, i) => ({ ...it, i })).filter(it => it.kind === (sc.tab === "img" ? "image" : "chat"));
  const nChat = sc.items.filter(x => x.kind === "chat").length, nImg = sc.items.length - nChat;
  const slice = view.slice(sc.page * PAGE, sc.page * PAGE + PAGE);
  const kb = [[
    { text: `${sc.tab === "chat" ? "● " : ""}💬 چت (${nChat})`, callback_data: "scan_tab_chat" },
    { text: `${sc.tab === "img" ? "● " : ""}🎨 تصویر (${nImg})`, callback_data: "scan_tab_img" }
  ]];
  for (const it of slice) {
    const added = have(it.kind === "image" ? imgL : chatL, it.id);
    kb.push([{ text: `${added ? "✅" : "➕"} ${it.id}${it.vision ? " 👁" : ""}`.slice(0, 60), callback_data: `scan_pick_${it.i}` }]);
  }
  kb.push(...nav("scan_pg_", sc.page, view.length));
  kb.push([{ text: "➕ افزودن همه این صفحه", callback_data: "scan_all" }, { text: "🔙 پروایدرها", callback_data: "admin_scan" }]);
  kb.push([{ text: "🛠 پنل مدیریت", callback_data: "admin_panel" }]);
  await show(botToken, chatId, messageId, `🔍 ${new URL(sc.base).hostname}: ${sc.items.length} مدل پیدا شد.\nروی هر مدل بزنید تا اضافه/حذف شود (✅ = فعال در ربات).`, kb);
}

async function togglePick(env, sc, items) {
  const [m, im] = await Promise.all([kvGet(env, "AI_MODELS"), kvGet(env, "IMAGE_MODELS")]);
  let chatL = parse(m, []), imgL = parse(im, []);
  let changedChat = false, changedImg = false;
  for (const it of items) {
    const isImg = it.kind === "image";
    const list = isImg ? imgL : chatL;
    const baseForModel = isImg ? sc.base : (isGemini(sc.base) ? GEMINI_OPENAI : sc.base);
    const idx = list.findIndex(x => x.modelName === it.id && norm(x.baseUrl) === norm(sc.base));
    if (idx >= 0 && items.length === 1) { list.splice(idx, 1); }
    else if (idx < 0) { list.push({ name: it.id, baseUrl: baseForModel, apiKey: sc.key, modelName: it.id, ...(isImg ? {} : { supportsVision: !!it.vision }) }); }
    else continue;
    if (isImg) changedImg = true; else changedChat = true;
  }
  if (changedChat) await kvSet(env, "AI_MODELS", JSON.stringify(chatL));
  if (changedImg) await kvSet(env, "IMAGE_MODELS", JSON.stringify(imgL));
}

/** returns true if the callback was handled */
export async function handleScanCallback(botToken, env, query, adminId) {
  const data = query.data, chatId = query.message.chat.id, mid = query.message.message_id;
  if (data === "noop") return true;
  if (data === "admin_scan") { await sendScanProviders(botToken, env, chatId, mid); return true; }
  if (data === "scan_new") {
    await kvSet(env, `ADMIN_STEP_${adminId}`, "SCAN_URL");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🌐 URL Base پروایدر را بفرستید (مثلاً https://api.openai.com/v1):" });
    return true;
  }
  if (data === "scan_gemini") {
    await kvSet(env, `TEMP_SCAN_${adminId}`, GEMINI_NATIVE, 3600);
    await kvSet(env, `ADMIN_STEP_${adminId}`, "SCAN_KEY");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔑 کلید API گوگل AI Studio را بفرستید (از aistudio.google.com/apikey):" });
    return true;
  }
  if (data.startsWith("scan_prov_")) {
    const provs = parse(await kvGet(env, "SCAN_PROVS"), []);
    const p = provs[parseInt(data.slice(10))];
    if (p) await runScan(botToken, env, chatId, adminId, p.base, p.key);
    return true;
  }
  const sc = await loadScan(env, adminId);
  if (!sc) { await sendScanPage(botToken, env, chatId, adminId, mid); return true; }
  if (data.startsWith("scan_tab_")) { sc.tab = data.slice(9); sc.page = 0; }
  else if (data.startsWith("scan_pg_")) sc.page = parseInt(data.slice(8)) || 0;
  else if (data.startsWith("scan_pick_")) { const it = sc.items[parseInt(data.slice(10))]; if (it) await togglePick(env, sc, [it]); }
  else if (data === "scan_all") {
    const view = sc.items.filter(it => it.kind === (sc.tab === "img" ? "image" : "chat"));
    await togglePick(env, sc, view.slice(sc.page * PAGE, sc.page * PAGE + PAGE));
  } else return false;
  await kvSet(env, `SCAN_${adminId}`, JSON.stringify(sc), 3600);
  await sendScanPage(botToken, env, chatId, adminId, mid);
  return true;
}

export async function handleScanStep(botToken, env, chatId, adminId, text, step) {
  if (step === "SCAN_URL") {
    await kvSet(env, `TEMP_SCAN_${adminId}`, text.trim(), 3600);
    await kvSet(env, `ADMIN_STEP_${adminId}`, "SCAN_KEY");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔑 API KEY را بفرستید (اگر ندارد `.` بفرستید):" });
  } else if (step === "SCAN_KEY") {
    const base = await kvGet(env, `TEMP_SCAN_${adminId}`);
    await redisCmd(env, ["DEL", `ADMIN_STEP_${adminId}`, `TEMP_SCAN_${adminId}`]);
    if (!base) { await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "⌛ منقضی شد؛ دوباره از پنل شروع کنید." }); return; }
    await runScan(botToken, env, chatId, adminId, isGemini(base) ? GEMINI_NATIVE : trimUrl(base), text.trim() === "." ? "" : text.trim());
  }
}
