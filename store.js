/**
 * Upstash Redis REST helpers (single command + pipeline) and the per-user
 * virtual file system used by the agent terminal.
 */

export async function redisCmd(env, cmd) {
  try {
    const res = await fetch(env.UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd)
    });
    const data = await res.json();
    return data.result ?? null;
  } catch (e) {
    console.error("redisCmd error:", e);
    return null;
  }
}

// One HTTP subrequest for many commands (Workers free plan allows only 50 per invocation).
export async function redisPipe(env, cmds) {
  if (!cmds.length) return [];
  try {
    const res = await fetch(`${env.UPSTASH_URL.replace(/\/+$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds)
    });
    const data = await res.json();
    return Array.isArray(data) ? data.map(d => d.result ?? null) : [];
  } catch (e) {
    console.error("redisPipe error:", e);
    return [];
  }
}

export const HOME = "/workspace";
const CWD_FIELD = "\u0001cwd";
export const MAX_FILE = 200 * 1024;
export const MAX_TOTAL = 1200 * 1024;

export class VFS {
  constructor(env, userId) {
    this.env = env;
    this.key = `WS_${userId}`;
    this.files = new Map();
    this.cwd = HOME;
    this.changed = new Set();
    this.removed = new Set();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    const raw = await redisCmd(this.env, ["HGETALL", this.key]);
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) this.files.set(raw[i], raw[i + 1]);
    } else if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) this.files.set(k, v);
    }
    if (this.files.has(CWD_FIELD)) {
      this.cwd = this.files.get(CWD_FIELD) || HOME;
      this.files.delete(CWD_FIELD);
    }
    this.loaded = true;
    return this;
  }

  async flush() {
    const cmds = [];
    if (this.changed.size) {
      const args = [];
      for (const p of this.changed) {
        if (this.files.has(p)) args.push(p, this.files.get(p));
      }
      if (args.length) cmds.push(["HSET", this.key, ...args]);
    }
    if (this.removed.size) cmds.push(["HDEL", this.key, ...this.removed]);
    cmds.push(["HSET", this.key, CWD_FIELD, this.cwd]);
    await redisPipe(this.env, cmds);
    this.changed.clear();
    this.removed.clear();
  }

  resolve(p, base = this.cwd) {
    if (!p || p === "~") p = p === "~" ? HOME : base;
    if (p.startsWith("~/")) p = HOME + p.slice(1);
    if (!p.startsWith("/")) p = `${base}/${p}`;
    const out = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return "/" + out.join("/");
  }

  isFile(p) { return this.files.has(p); }

  isDir(p) {
    if (p === "/" || p === HOME) return true;
    const prefix = p + "/";
    for (const k of this.files.keys()) if (k === prefix || k.startsWith(prefix)) return true;
    return false;
  }

  exists(p) { return this.isFile(p) || this.isDir(p); }

  read(p) { return this.files.get(p); }

  totalSize() {
    let n = 0;
    for (const v of this.files.values()) n += v.length;
    return n;
  }

  write(p, content, append = false) {
    if (this.isDir(p)) return `${p}: Is a directory`;
    const next = append && this.files.has(p) ? this.files.get(p) + content : content;
    if (next.length > MAX_FILE) return `${p}: file too large (max ${MAX_FILE / 1024}KB)`;
    const delta = next.length - (this.files.get(p)?.length || 0);
    if (this.totalSize() + delta > MAX_TOTAL) return "workspace quota exceeded (max ~1.2MB), delete some files";
    this.files.set(p, next);
    this.changed.add(p);
    this.removed.delete(p);
    return null;
  }

  mkdir(p) {
    const marker = p + "/";
    if (!this.files.has(marker) && !this.isDir(p)) {
      this.files.set(marker, "");
      this.changed.add(marker);
      this.removed.delete(marker);
    }
  }

  remove(p) {
    if (this.files.delete(p)) { this.changed.delete(p); this.removed.add(p); }
  }

  removeTree(p) {
    const prefix = p + "/";
    for (const k of [...this.files.keys()]) {
      if (k === p || k === prefix || k.startsWith(prefix)) this.remove(k);
    }
  }

  // Direct children of a directory: [{name, dir, size}]
  list(dirPath) {
    const prefix = dirPath === "/" ? "/" : dirPath + "/";
    const entries = new Map();
    for (const [k, v] of this.files) {
      if (!k.startsWith(prefix) || k === prefix) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, { name: rest, dir: false, size: v.length });
      else {
        const name = rest.slice(0, slash);
        if (!entries.has(name) || !entries.get(name).dir) entries.set(name, { name, dir: true, size: 0 });
      }
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // All file paths at or below a path
  walk(p) {
    if (this.isFile(p)) return [p];
    const prefix = p === "/" ? "/" : p + "/";
    return [...this.files.keys()].filter(k => k.startsWith(prefix) && !k.endsWith("/")).sort();
  }

  glob(pattern) {
    const abs = this.resolve(pattern);
    const re = new RegExp("^" + abs.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
    const hits = new Set();
    for (const k of this.files.keys()) {
      const parts = k.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const cand = "/" + parts.slice(0, i).join("/");
        if (re.test(cand)) hits.add(cand);
      }
    }
    return [...hits].sort();
  }
}
