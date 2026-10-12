/**
 * Free online tools: web search (DuckDuckGo, no key), readable page fetch,
 * and speech-to-text with Cloudflare Workers AI Whisper (binding `AI`,
 * included in the Workers free plan daily allowance).
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();
}

// ==========================================
// Web search
// ==========================================
export async function webSearch(query, max = 8) {
  const q = String(query || "").trim();
  if (!q) return { results: [], error: "empty query" };
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": UA, "Accept-Language": "fa,en;q=0.8" }, signal: ctl.signal
    });
    const html = await res.text();
    const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class='result-link'>([\s\S]*?)<\/a>/g)];
    const snippets = [...html.matchAll(/class='result-snippet'>([\s\S]*?)<\/td>/g)].map(m => decodeEntities(m[1]));
    const results = [];
    links.forEach((m, i) => {
      let url = m[1].replace(/&amp;/g, "&");
      const u = url.match(/[?&]uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
      if (url.startsWith("//")) url = "https:" + url;
      if (/duckduckgo\.com\/y\.js|ad_domain/.test(url)) return; // sponsored
      results.push({ title: decodeEntities(m[2]), url, snippet: snippets[i] || "" });
    });
    if (results.length) return { results: results.slice(0, max) };
    return await wikiSearch(q, max, ctl.signal);
  } catch (e) {
    return { results: [], error: e.name === "AbortError" ? "search timeout" : e.message };
  } finally { clearTimeout(tm); }
}

// Fallback when DuckDuckGo returns nothing (e.g. rate limited)
async function wikiSearch(q, max, signal) {
  const lang = /[؀-ۿ]/.test(q) ? "fa" : "en";
  const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${max}&srsearch=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA }, signal });
  const d = await res.json();
  const results = (d.query?.search || []).map(r => ({
    title: r.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`, snippet: decodeEntities(r.snippet)
  }));
  return results.length ? { results, note: "results from Wikipedia" } : { results: [], error: "no results" };
}

export function formatResults(r) {
  if (!r.results.length) return `no results (${r.error || "empty"})`;
  return (r.note ? `(${r.note})\n` : "") + r.results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join("\n\n");
}

// ==========================================
// Readable page text
// ==========================================
export async function readUrl(url, maxChars = 12000) {
  let u = String(url || "").trim();
  if (!/^https?:\/\//.test(u)) u = "https://" + u;
  let host;
  try { host = new URL(u).hostname; } catch { return "error: bad URL"; }
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host.endsWith(".internal")) return "error: private addresses are blocked";
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "fa,en;q=0.8" }, redirect: "follow", signal: ctl.signal });
    const type = res.headers.get("content-type") || "";
    let body = await res.text();
    if (/html/.test(type) || /^\s*</.test(body)) {
      const title = decodeEntities((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
      body = body
        .replace(/<(script|style|noscript|svg|nav|footer|form|iframe)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<head[\s\S]*?<\/head>/i, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ");
      body = (title ? `# ${title}\n\n` : "") + body.split("\n").map(decodeEntities).filter(l => l.length > 1).join("\n");
    }
    const text = body.length > maxChars ? body.slice(0, maxChars) + `\n...[truncated, ${body.length} chars total]` : body;
    return `[HTTP ${res.status}] ${u}\n\n${text}`;
  } catch (e) {
    return `error: ${e.name === "AbortError" ? "timeout" : e.message}`;
  } finally { clearTimeout(tm); }
}

// ==========================================
// Speech to text
// ==========================================
export async function transcribe(env, botToken, fileId) {
  if (!env.AI) return { error: "Workers AI binding (AI) is not configured" };
  const info = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: fileId })
  }).then(r => r.json()).catch(() => null);
  if (!info?.ok) return { error: "could not get the voice file from Telegram (max 20MB)" };
  const bytes = new Uint8Array(await (await fetch(`https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`)).arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) return { error: "audio too large" };
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  try {
    const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: btoa(bin) });
    return { text: (out.text || "").trim(), language: out.transcription_info?.language, duration: out.transcription_info?.duration };
  } catch (e) {
    try { // older model as a fallback
      const out = await env.AI.run("@cf/openai/whisper", { audio: [...bytes] });
      return { text: (out.text || "").trim() };
    } catch (e2) {
      return { error: e2.message || e.message };
    }
  }
}
