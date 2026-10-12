/**
 * Virtual bash-like shell. Files live in Redis (see store.js); programs
 * (node, python, gcc, go, rust, ...) are executed on the public Wandbox
 * sandbox, so no VPS / container is needed.
 */
import { HOME, MAX_FILE } from "./store.js";

const MAX_OUT = 8000;
const WANDBOX = "https://wandbox.org/api/compile.json";

const RUNNERS = {
  node:    { compiler: "nodejs-20.17.0", ext: ".js" },
  nodejs:  { compiler: "nodejs-20.17.0", ext: ".js" },
  python:  { compiler: "cpython-3.12.7", ext: ".py" },
  python3: { compiler: "cpython-3.12.7", ext: ".py" },
  bash:    { compiler: "bash", ext: ".sh" },
  sh:      { compiler: "bash", ext: ".sh" },
  ruby:    { compiler: "ruby-3.4.9", ext: ".rb" },
  php:     { compiler: "php-8.3.12", ext: ".php" },
  lua:     { compiler: "lua-5.4.7", ext: ".lua" },
  perl:    { compiler: "perl-5.40.0", ext: ".pl" },
  gcc:     { compiler: "gcc-13.2.0-c", ext: ".c", opts: ["-lm"] },
  cc:      { compiler: "gcc-13.2.0-c", ext: ".c", opts: ["-lm"] },
  "g++":   { compiler: "gcc-13.2.0", ext: ".cpp", opts: ["-std=c++20"] },
  "c++":   { compiler: "gcc-13.2.0", ext: ".cpp", opts: ["-std=c++20"] },
  go:      { compiler: "go-1.23.2", ext: ".go" },
  rustc:   { compiler: "rust-1.82.0", ext: ".rs" },
  tsc:     { compiler: "typescript-5.6.2", ext: ".ts" },
  ts:      { compiler: "typescript-5.6.2", ext: ".ts" },
  sqlite3: { compiler: "sqlite-3.46.1", ext: ".sql" }
};

export function clip(s, max = MAX_OUT) {
  s = String(s ?? "");
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + `\n...[${s.length - max} chars truncated]...\n` + s.slice(-half);
}

const ok = (out = "") => ({ out, err: "", code: 0 });
const fail = (err, code = 1) => ({ out: "", err: err.endsWith("\n") ? err : err + "\n", code });

export class Shell {
  constructor(vfs, opts = {}) {
    this.vfs = vfs;
    this.env = { HOME, USER: "agent", PWD: vfs.cwd, SHELL: "/bin/bash", PATH: "/usr/bin:/bin", ...(opts.env || {}) };
    this.depth = 0;
    this.netCalls = 0;
    this.maxNet = opts.maxNet ?? 6;
    this.onSendFile = opts.onSendFile || null;
  }

  // ---------- public entry ----------
  async run(script) {
    const lines = String(script).replace(/\r\n/g, "\n").split("\n");
    let out = "", code = 0;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      let stdin = null;
      const hd = line.match(/<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/);
      if (hd) {
        const delim = hd[2], strip = line.includes("<<-"), body = [];
        i++;
        while (i < lines.length && (strip ? lines[i].trim() : lines[i]) !== delim) body.push(lines[i++]);
        stdin = body.join("\n") + (body.length ? "\n" : "");
        if (hd[1] !== "'" && hd[1] !== '"') stdin = await this.expand(stdin, true);
        line = line.replace(hd[0], "");
      }
      const r = await this.runLine(line, stdin);
      out += r.out + r.err;
      code = r.code;
      this.vfs.cwd = this.vfs.cwd || HOME;
    }
    return { out, code };
  }

  // ---------- parsing ----------
  async expand(str, heredoc = false) {
    // $VAR, ${VAR}, $(cmd), $? inside a string
    let res = "";
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === "\\" && heredoc && i + 1 < str.length && "$`\\".includes(str[i + 1])) { res += str[++i]; continue; }
      if (c !== "$") { res += c; continue; }
      if (str[i + 1] === "(") {
        let depth = 1, j = i + 2;
        while (j < str.length && depth) { if (str[j] === "(") depth++; else if (str[j] === ")") depth--; j++; }
        const inner = str.slice(i + 2, j - 1);
        if (this.depth < 3) {
          this.depth++;
          const r = await this.run(inner);
          this.depth--;
          res += r.out.replace(/\n+$/, "");
        }
        i = j - 1;
      } else if (str[i + 1] === "{") {
        const j = str.indexOf("}", i);
        if (j > 0) { res += this.env[str.slice(i + 2, j)] ?? ""; i = j; } else res += c;
      } else if (str[i + 1] === "?") { res += String(this.lastCode ?? 0); i++; }
      else {
        const m = str.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (m) { res += this.env[m[0]] ?? ""; i += m[0].length; } else res += c;
      }
    }
    return res;
  }

  async tokenize(line) {
    const toks = [];
    let cur = "", has = false, glob = false;
    const push = () => { if (has) toks.push({ t: "w", v: cur, glob }); cur = ""; has = false; glob = false; };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        const end = j === -1 ? line.length : j;
        cur += line.slice(i + 1, end); has = true; i = end;
      } else if (c === '"') {
        let j = i + 1, buf = "";
        while (j < line.length && line[j] !== '"') {
          if (line[j] === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) { buf += line[j + 1]; j += 2; continue; }
          if (line[j] === "$" && line[j + 1] === "(") {
            let d = 1, k = j + 2;
            while (k < line.length && d) { if (line[k] === "(") d++; else if (line[k] === ")") d--; k++; }
            buf += line.slice(j, k); j = k; continue;
          }
          buf += line[j++];
        }
        cur += await this.expand(buf); has = true; i = j;
      } else if (c === "\\" && i + 1 < line.length) {
        cur += line[++i]; has = true;
      } else if (c === "$") {
        let j = i + 1, raw;
        if (line[j] === "(") {
          let d = 1; j++;
          while (j < line.length && d) { if (line[j] === "(") d++; else if (line[j] === ")") d--; j++; }
          raw = line.slice(i, j);
        } else if (line[j] === "{") {
          const e = line.indexOf("}", j); j = e === -1 ? line.length : e + 1; raw = line.slice(i, j);
        } else {
          const m = line.slice(j).match(/^([A-Za-z_][A-Za-z0-9_]*|\?)/);
          j += m ? m[0].length : 0; raw = line.slice(i, j);
        }
        cur += await this.expand(raw); has = true; i = j - 1;
      } else if (/\s/.test(c)) {
        push();
      } else if (c === "#" && !has) {
        break;
      } else if (c === "|" || c === "&" || c === ";" || c === ">" || c === "<") {
        // fd redirects like 2> or 2>>
        let fd = "";
        if ((c === ">") && /^[12]$/.test(cur) && has) { fd = cur; cur = ""; has = false; }
        else push();
        let op = c;
        if ((c === "|" && line[i + 1] === "|") || (c === "&" && line[i + 1] === "&") || (c === ">" && line[i + 1] === ">")) { op += line[++i]; }
        if (c === ">" && line[i + 1] === "&") { op += "&" + line[i + 2]; i += 2; }
        toks.push({ t: "op", v: op, fd });
      } else {
        if (c === "*" || c === "?" || c === "[") glob = true;
        cur += c; has = true;
      }
    }
    push();
    return toks;
  }

  // split a line on top-level ; && || (outside quotes and $( ))
  splitTop(line) {
    const segs = []; let cur = "", sep = null, q = null, depth = 0;
    const cut = (nextSep) => { if (cur.trim()) segs.push({ text: cur, sep }); cur = ""; sep = nextSep; };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { cur += c; if (c === "\\" && q === '"') cur += line[++i] ?? ""; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; continue; }
      if (c === "\\") { cur += c + (line[++i] ?? ""); continue; }
      if (c === "$" && line[i + 1] === "(") { depth++; cur += "$("; i++; continue; }
      if (c === "(" && depth) { depth++; cur += c; continue; }
      if (c === ")" && depth) { depth--; cur += c; continue; }
      if (!depth) {
        if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
        if (c === ";") { cut(";"); continue; }
        if (c === "&" && line[i + 1] === "&") { cut("&&"); i++; continue; }
        if (c === "|" && line[i + 1] === "|") { cut("||"); i++; continue; }
      }
      cur += c;
    }
    cut(null);
    return segs;
  }

  async runLine(line, stdin = null) {
    let out = "", code = 0, first = true;
    for (const seg of this.splitTop(line)) {
      if (!first) {
        if (seg.sep === "&&" && code !== 0) continue;
        if (seg.sep === "||" && code === 0) continue;
      }
      first = false;
      const toks = await this.tokenize(seg.text);
      const stages = [[]];
      for (const tk of toks) {
        if (tk.t === "op" && tk.v === "|") stages.push([]);
        else if (tk.t === "op" && tk.v === "&") continue;
        else stages[stages.length - 1].push(tk);
      }
      const r = await this.runPipeline(stages, stdin);
      stdin = null;
      out += r.out + r.err;
      code = r.code;
      this.lastCode = code;
    }
    return { out, err: "", code };
  }

  async runPipeline(stages, stdin) {
    let data = stdin ?? "";
    let result = ok();
    let errAll = "";
    for (let i = 0; i < stages.length; i++) {
      const r = await this.runSimple(stages[i], data);
      data = r.out;
      errAll += r.err;
      result = r;
    }
    return { out: result.out, err: errAll, code: result.code };
  }

  async runSimple(tokens, stdin) {
    let args = [];
    const redir = { out: null, append: false, errNull: false, errToOut: false };
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk.t === "op") {
        if (tk.v === ">&1" || tk.v === ">&2") { if (tk.fd === "2") redir.errToOut = true; continue; }
        if (tk.v === "<") { const f = tokens[++i]; if (f) { const p = this.vfs.resolve(f.v); if (this.vfs.isFile(p)) stdin = this.vfs.read(p); else return fail(`${f.v}: No such file`); } continue; }
        const target = tokens[++i];
        if (!target) return fail("syntax error near unexpected token `newline'");
        if (tk.fd === "2") { if (target.v === "/dev/null") redir.errNull = true; else redir.errToOut = true; continue; }
        if (target.v === "/dev/null") { redir.out = "/dev/null"; continue; }
        redir.out = this.vfs.resolve(target.v);
        redir.append = tk.v === ">>";
      } else args.push(tk);
    }
    // env assignments
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0].v) && !args[0].glob) {
      const [k, ...rest] = args.shift().v.split("=");
      this.env[k] = rest.join("=");
    }
    if (!args.length) return ok();
    // glob expansion
    const argv = [];
    for (const a of args) {
      if (a.glob) { const m = this.vfs.glob(a.v); if (m.length) { argv.push(...m.map(p => (a.v.startsWith("/") ? p : this.rel(p)))); continue; } }
      argv.push(a.v);
    }
    let res;
    try {
      res = await this.exec(argv, stdin ?? "");
    } catch (e) {
      res = fail(`${argv[0]}: ${e.message || e}`);
    }
    if (redir.errToOut) { res = { out: res.out + res.err, err: "", code: res.code }; }
    if (redir.errNull) res.err = "";
    if (redir.out) {
      if (redir.out !== "/dev/null") {
        const e = this.vfs.write(redir.out, res.out, redir.append);
        if (e) return fail(e);
      }
      res.out = "";
    }
    return res;
  }

  rel(abs) {
    const cwd = this.vfs.cwd === "/" ? "/" : this.vfs.cwd + "/";
    return abs.startsWith(cwd) ? abs.slice(cwd.length) : abs;
  }

  // ---------- commands ----------
  async exec(argv, stdin) {
    const [cmd, ...a] = argv;
    const v = this.vfs;
    const flags = a.filter(x => /^-[A-Za-z]+$/.test(x)).join("");
    const rest = a.filter(x => !/^-[A-Za-z]+$/.test(x));
    switch (cmd) {
      case "true": return ok();
      case "false": return { out: "", err: "", code: 1 };
      case "clear": return ok();
      case "whoami": return ok("agent\n");
      case "date": return ok(new Date().toString() + "\n");
      case "uname": return ok("Linux hellboy-agent 6.0 x86_64 (virtual)\n");
      case "pwd": return ok(v.cwd + "\n");
      case "help": return ok(HELP);
      case "env": case "printenv": return ok(Object.entries(this.env).map(([k, x]) => `${k}=${x}`).join("\n") + "\n");
      case "export": for (const x of a) { const [k, ...r] = x.split("="); if (r.length) this.env[k] = r.join("="); } return ok();
      case "which": return ok(rest.map(x => (RUNNERS[x] || BUILTINS.has(x)) ? `/usr/bin/${x}` : "").filter(Boolean).join("\n") + "\n");
      case "echo": {
        const noNl = a[0] === "-n";
        let s = (noNl ? a.slice(1) : a).join(" ");
        if (a[0] === "-e") s = a.slice(1).join(" ").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        return ok(s + (noNl ? "" : "\n"));
      }
      case "printf": {
        let fmt = a[0] || "", i = 1;
        fmt = fmt.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        return ok(fmt.replace(/%[sd]/g, () => a[i++] ?? ""));
      }
      case "cd": {
        const p = v.resolve(a[0] || "~");
        if (!v.isDir(p)) return fail(`cd: ${a[0]}: No such directory`);
        v.cwd = p; this.env.PWD = p; return ok();
      }
      case "ls": return this.ls(a);
      case "tree": return this.tree(rest[0]);
      case "cat": {
        if (!rest.length) return ok(stdin);
        let out = "";
        for (const f of rest) {
          const p = v.resolve(f);
          if (!v.isFile(p)) return { out, err: `cat: ${f}: No such file or directory\n`, code: 1 };
          out += v.read(p);
        }
        if (flags.includes("n")) out = out.replace(/\n$/, "").split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n") + "\n";
        return ok(out);
      }
      case "mkdir": {
        for (const f of rest) {
          const p = v.resolve(f);
          if (v.isFile(p)) return fail(`mkdir: ${f}: File exists`);
          if (!flags.includes("p")) { const parent = p.slice(0, p.lastIndexOf("/")) || "/"; if (!v.isDir(parent)) return fail(`mkdir: ${f}: No such parent directory (use -p)`); }
          v.mkdir(p);
        }
        return ok();
      }
      case "touch": for (const f of rest) { const p = v.resolve(f); if (!v.isFile(p)) { const e = v.write(p, ""); if (e) return fail(e); } } return ok();
      case "rm": case "rmdir": {
        for (const f of rest) {
          const p = v.resolve(f);
          if (!v.exists(p)) { if (flags.includes("f")) continue; return fail(`rm: ${f}: No such file or directory`); }
          if (v.isDir(p) && !flags.includes("r") && !flags.includes("R") && cmd === "rm") return fail(`rm: ${f}: is a directory (use -r)`);
          v.removeTree(p);
          v.remove(p);
        }
        return ok();
      }
      case "cp": case "mv": {
        if (rest.length < 2) return fail(`${cmd}: missing operand`);
        const dest = v.resolve(rest[rest.length - 1]);
        const srcs = rest.slice(0, -1);
        for (const s of srcs) {
          const sp = v.resolve(s);
          if (!v.exists(sp)) return fail(`${cmd}: ${s}: No such file or directory`);
          const base = sp.split("/").pop();
          const target = v.isDir(dest) || srcs.length > 1 ? `${dest}/${base}` : dest;
          if (v.isDir(sp)) {
            if (cmd === "cp" && !/[rR]/.test(flags)) return fail(`cp: ${s}: is a directory (use -r)`);
            for (const f of v.walk(sp)) { const e = v.write(target + f.slice(sp.length), v.read(f)); if (e) return fail(e); }
          } else { const e = v.write(target, v.read(sp)); if (e) return fail(e); }
          if (cmd === "mv") { v.removeTree(sp); v.remove(sp); }
        }
        return ok();
      }
      case "head": case "tail": {
        let n = 10;
        const ni = a.indexOf("-n"); if (ni >= 0) n = parseInt(a[ni + 1]) || 10;
        const m = a.find(x => /^-\d+$/.test(x)); if (m) n = -parseInt(m);
        const files = rest.filter(x => String(parseInt(x)) !== x);
        const text = files.length ? files.map(f => v.read(v.resolve(f)) ?? "").join("") : stdin;
        const lines = text.replace(/\n$/, "").split("\n");
        return ok((cmd === "head" ? lines.slice(0, n) : lines.slice(-n)).join("\n") + "\n");
      }
      case "wc": {
        const text = rest.length ? rest.map(f => v.read(v.resolve(f)) ?? "").join("") : stdin;
        const l = (text.match(/\n/g) || []).length, w = text.trim() ? text.trim().split(/\s+/).length : 0, c = text.length;
        if (flags.includes("l")) return ok(`${l}\n`);
        if (flags.includes("w")) return ok(`${w}\n`);
        if (flags.includes("c")) return ok(`${c}\n`);
        return ok(`${l} ${w} ${c}\n`);
      }
      case "sort": {
        const text = rest.length ? rest.map(f => v.read(v.resolve(f)) ?? "").join("") : stdin;
        let lines = text.replace(/\n$/, "").split("\n");
        lines.sort(flags.includes("n") ? (x, y) => parseFloat(x) - parseFloat(y) : undefined);
        if (flags.includes("r")) lines.reverse();
        if (flags.includes("u")) lines = [...new Set(lines)];
        return ok(lines.join("\n") + "\n");
      }
      case "uniq": {
        const lines = stdin.replace(/\n$/, "").split("\n");
        return ok(lines.filter((l, i) => l !== lines[i - 1]).join("\n") + "\n");
      }
      case "tee": {
        for (const f of rest) { const e = v.write(v.resolve(f), stdin, flags.includes("a")); if (e) return fail(e); }
        return ok(stdin);
      }
      case "grep": return this.grep(a, stdin);
      case "find": return this.find(a);
      case "sed": return this.sed(a, stdin);
      case "curl": case "wget": return this.curl(cmd, a);
      case "send": case "sendfile": return this.sendFile(rest[0], rest.slice(1).join(" "));
      case "diff": {
        const x = v.read(v.resolve(rest[0])), y = v.read(v.resolve(rest[1]));
        if (x === undefined || y === undefined) return fail("diff: file not found");
        if (x === y) return ok();
        const xl = x.split("\n"), yl = y.split("\n"), out = [];
        for (let i = 0; i < Math.max(xl.length, yl.length); i++) if (xl[i] !== yl[i]) { if (xl[i] !== undefined) out.push(`< ${xl[i]}`); if (yl[i] !== undefined) out.push(`> ${yl[i]}`); }
        return { out: out.join("\n") + "\n", err: "", code: 1 };
      }
      case "pip": case "pip3": case "npm": case "apt": case "apt-get": case "yarn": case "pnpm":
        return fail(`${cmd}: package installation is not available in this sandbox. Use the standard library / built-in modules only (node: fetch, fs-free code; python: stdlib).`, 127);
      case "git": case "sudo": case "docker": case "ssh":
        return fail(`${cmd}: not available in this virtual terminal`, 127);
      case "python": case "python3": case "node": case "nodejs": case "bash": case "sh": case "ruby": case "php": case "lua": case "perl":
      case "gcc": case "cc": case "g++": case "c++": case "go": case "rustc": case "tsc": case "ts": case "sqlite3":
        return this.runProgram(cmd, a, stdin);
      default:
        if (cmd.startsWith("./")) {
          const p = v.resolve(cmd);
          if (v.isFile(p)) return this.runProgram("bash", [cmd], stdin);
        }
        return fail(`${cmd}: command not found (type 'help' for available commands)`, 127);
    }
  }

  ls(a) {
    const v = this.vfs;
    const long = a.some(x => /^-[A-Za-z]*l/.test(x)), all = a.some(x => /^-[A-Za-z]*a/.test(x)), rec = a.some(x => /^-[A-Za-z]*R/.test(x));
    const targets = a.filter(x => !x.startsWith("-"));
    const show = (p, label) => {
      let ents = v.list(p).filter(e => all || !e.name.startsWith("."));
      let out = label ? `${label}:\n` : "";
      out += long ? ents.map(e => `${e.dir ? "d" : "-"}rw-r--r--  ${String(e.size).padStart(8)}  ${e.name}${e.dir ? "/" : ""}`).join("\n")
                  : ents.map(e => e.name + (e.dir ? "/" : "")).join("  ");
      out += ents.length ? "\n" : "";
      if (rec) for (const e of ents.filter(x => x.dir)) out += "\n" + show(p === "/" ? "/" + e.name : `${p}/${e.name}`, `${p}/${e.name}`);
      return out;
    };
    let out = "";
    for (const t of targets.length ? targets : ["."]) {
      const p = v.resolve(t);
      if (v.isFile(p)) out += `${t}\n`;
      else if (v.isDir(p)) out += show(p, targets.length > 1 ? t : "");
      else return fail(`ls: cannot access '${t}': No such file or directory`);
    }
    return ok(out);
  }

  tree(target) {
    const v = this.vfs;
    const root = v.resolve(target || ".");
    if (!v.isDir(root)) return fail(`tree: ${target}: not a directory`);
    let count = 0;
    const walk = (p, prefix) => {
      const ents = v.list(p);
      let s = "";
      ents.forEach((e, i) => {
        if (++count > 300) return;
        const last = i === ents.length - 1;
        s += `${prefix}${last ? "└── " : "├── "}${e.name}${e.dir ? "/" : ""}\n`;
        if (e.dir) s += walk(p === "/" ? "/" + e.name : `${p}/${e.name}`, prefix + (last ? "    " : "│   "));
      });
      return s;
    };
    return ok(`${root}\n${walk(root, "")}`);
  }

  grep(a, stdin) {
    const v = this.vfs;
    let ic = false, num = false, inv = false, cnt = false, lonly = false, rec = false, fixed = false;
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      if (/^-[A-Za-z]+$/.test(a[i])) {
        for (const ch of a[i].slice(1)) { if (ch === "i") ic = true; else if (ch === "n") num = true; else if (ch === "v") inv = true; else if (ch === "c") cnt = true; else if (ch === "l") lonly = true; else if (ch === "r" || ch === "R") rec = true; else if (ch === "F") fixed = true; }
      } else if (a[i] === "-e") pos.push(a[++i]); else pos.push(a[i]);
    }
    if (!pos.length) return fail("grep: missing pattern", 2);
    const pat = pos.shift();
    let re;
    try { re = new RegExp(fixed ? pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pat, ic ? "i" : ""); } catch (e) { return fail(`grep: invalid regex: ${e.message}`, 2); }
    let files = [];
    if (pos.length) { for (const f of pos) { const p = v.resolve(f); if (v.isDir(p)) { if (rec) files.push(...v.walk(p)); } else if (v.isFile(p)) files.push(p); else return fail(`grep: ${f}: No such file or directory`, 2); } }
    else if (rec) files = v.walk(v.cwd);
    const multi = files.length > 1 || rec;
    const out = []; let any = false;
    const scan = (text, label) => {
      let c = 0;
      text.split("\n").forEach((line, i) => {
        if (re.test(line) !== inv) { c++; any = true; if (!cnt && !lonly) out.push(`${multi && label ? label + ":" : ""}${num ? (i + 1) + ":" : ""}${line}`); }
      });
      if (cnt) out.push(`${multi && label ? label + ":" : ""}${c}`);
      if (lonly && c) out.push(label);
    };
    if (files.length) files.forEach(f => scan(v.read(f), this.rel(f))); else scan(stdin.replace(/\n$/, ""), "");
    return { out: out.length ? out.join("\n") + "\n" : "", err: "", code: any ? 0 : 1 };
  }

  find(a) {
    const v = this.vfs;
    let start = ".", name = null, type = null, maxd = Infinity;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "-name") name = a[++i]; else if (a[i] === "-type") type = a[++i]; else if (a[i] === "-maxdepth") maxd = parseInt(a[++i]); else if (!a[i].startsWith("-")) start = a[i];
    }
    const root = v.resolve(start);
    if (!v.exists(root)) return fail(`find: '${start}': No such file or directory`);
    const nameRe = name ? new RegExp("^" + name.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
    const res = new Set([root]);
    const prefix = root === "/" ? "/" : root + "/";
    for (const k of v.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const parts = k.slice(prefix.length).split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) if (i <= maxd) res.add(prefix + parts.slice(0, i).join("/"));
    }
    const out = [...res].sort().filter(p => {
      if (type === "f" && !v.isFile(p)) return false;
      if (type === "d" && !v.isDir(p)) return false;
      return !nameRe || nameRe.test(p.split("/").pop());
    }).slice(0, 300).map(p => (start.startsWith("/") ? p : "./" + this.rel(p) || "."));
    return ok(out.join("\n") + "\n");
  }

  sed(a, stdin) {
    const v = this.vfs;
    let inplace = false, quiet = false; const exprs = []; const files = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "-i") inplace = true; else if (a[i] === "-n") quiet = true; else if (a[i] === "-e") exprs.push(a[++i]);
      else if (a[i] === "-E" || a[i] === "-r") continue; else if (!exprs.length && !a[i].startsWith("-")) exprs.push(a[i]); else files.push(a[i]);
    }
    const apply = (text) => {
      let lines = text.replace(/\n$/, "").split("\n");
      for (const e of exprs) {
        let m;
        if ((m = e.match(/^(\d+)(?:,(\d+))?([pd])$/))) {
          const s = +m[1], t = m[2] ? +m[2] : s;
          lines = m[3] === "p" ? lines.filter((_, i) => i + 1 >= s && i + 1 <= t) : lines.filter((_, i) => !(i + 1 >= s && i + 1 <= t));
        } else if ((m = e.match(/^s(.)(.*?)(?<!\\)\1(.*?)(?<!\\)\1([gi]*)$/))) {
          const re = new RegExp(m[2], m[4].replace(/[^gi]/g, ""));
          lines = lines.map(l => l.replace(re, m[3]));
        } else throw new Error(`unsupported expression: ${e}`);
      }
      return lines.join("\n") + "\n";
    };
    try {
      if (files.length) {
        let out = "";
        for (const f of files) {
          const p = v.resolve(f);
          if (!v.isFile(p)) return fail(`sed: ${f}: No such file`);
          const r = apply(v.read(p));
          if (inplace) v.write(p, r); else out += r;
        }
        return ok(out);
      }
      return ok(apply(stdin));
    } catch (e) { return fail(`sed: ${e.message}`); }
  }

  async curl(cmd, a) {
    if (++this.netCalls > this.maxNet) return fail("network call limit reached for this step");
    let method = "GET", url = null, body, outFile = null, headOnly = false; const headers = {};
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === "-X" || x === "--request") method = a[++i].toUpperCase();
      else if (x === "-H" || x === "--header") { const h = a[++i]; const k = h.indexOf(":"); headers[h.slice(0, k).trim()] = h.slice(k + 1).trim(); }
      else if (x === "-d" || x === "--data" || x === "--data-raw") { body = a[++i]; if (method === "GET") method = "POST"; }
      else if (x === "-o" || x === "-O" || x === "--output") outFile = a[++i];
      else if (x === "-I" || x === "--head") headOnly = true;
      else if (!x.startsWith("-")) url = x;
    }
    if (!url) return fail(`${cmd}: no URL specified`);
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    let host;
    try { host = new URL(url).hostname; } catch { return fail(`${cmd}: bad URL`); }
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host.endsWith(".internal")) return fail(`${cmd}: private addresses are blocked`);
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(url, { method: headOnly ? "HEAD" : method, headers, body, signal: ctl.signal, redirect: "follow" });
      if (headOnly) return ok(`HTTP ${res.status}\n` + [...res.headers].map(([k, x]) => `${k}: ${x}`).join("\n") + "\n");
      const text = (await res.text()).slice(0, MAX_FILE);
      if (outFile) { const e = this.vfs.write(this.vfs.resolve(outFile), text); return e ? fail(e) : ok(); }
      return { out: text + (text.endsWith("\n") ? "" : "\n"), err: res.ok ? "" : `[HTTP ${res.status}]\n`, code: res.ok ? 0 : 22 };
    } catch (e) { return fail(`${cmd}: ${e.name === "AbortError" ? "timeout" : e.message}`); }
    finally { clearTimeout(tm); }
  }

  async sendFile(path, caption) {
    if (!path) return fail("usage: send <file> [caption]");
    const p = this.vfs.resolve(path);
    if (!this.vfs.isFile(p)) return fail(`send: ${path}: No such file`);
    if (!this.onSendFile) return fail("send: not supported here");
    const okSent = await this.onSendFile(p.split("/").pop(), this.vfs.read(p), caption);
    return okSent ? ok(`sent ${path} to the user\n`) : fail("send: telegram upload failed");
  }

  // ---------- program runner (Wandbox sandbox) ----------
  async runProgram(cmd, a, stdin) {
    const v = this.vfs;
    if (++this.netCalls > this.maxNet) return fail("execution limit reached for this step");
    let runner = RUNNERS[cmd];
    let argsRest = [...a];
    let mainFile, mainCode, progArgs = [];
    let compilerOpts = [...(runner.opts || [])];

    // inline code: node -e / python -c / bash -c
    const inlineIdx = argsRest.findIndex(x => x === "-e" || x === "-c" || x === "-p");
    if (inlineIdx >= 0 && argsRest[inlineIdx + 1] !== undefined) {
      mainCode = argsRest[inlineIdx + 1]; mainFile = "inline" + runner.ext;
      progArgs = argsRest.slice(inlineIdx + 2);
    } else {
      // skip compiler/interpreter flags
      const files = []; let i = 0;
      if (cmd === "go") { if (argsRest[0] === "run") argsRest.shift(); else return fail("only `go run file.go` is supported"); }
      for (; i < argsRest.length; i++) {
        const x = argsRest[i];
        if (x === "-o") { i++; continue; }
        if (x.startsWith("-")) { if (["gcc", "cc", "g++", "c++", "rustc"].includes(cmd)) compilerOpts.push(x); continue; }
        files.push(x);
      }
      if (!files.length) {
        if (stdin && ["bash", "sh", "python", "python3", "node", "nodejs"].includes(cmd)) { mainCode = stdin; mainFile = "stdin" + runner.ext; stdin = ""; }
        else return fail(`${cmd}: no input file`);
      } else {
        const p = v.resolve(files[0]);
        if (!v.isFile(p)) return fail(`${cmd}: ${files[0]}: No such file or directory`);
        mainFile = p; mainCode = v.read(p);
        // extra source files given to a compiler (gcc a.c b.c) are attached as additional files
        progArgs = ["gcc", "cc", "g++", "c++", "rustc"].includes(cmd) ? [] : files.slice(1);
      }
    }

    // attach sibling files from the same directory so imports/includes work
    const dir = mainFile.startsWith("/") ? mainFile.slice(0, mainFile.lastIndexOf("/")) || "/" : v.cwd;
    const codes = []; let budget = 600 * 1024;
    for (const f of v.walk(dir)) {
      if (f === mainFile) continue;
      const content = v.read(f);
      if (budget - content.length < 0) continue;
      budget -= content.length;
      codes.push({ file: f.slice(dir === "/" ? 1 : dir.length + 1), code: content });
    }
    // extra translation units for compilers
    if (["gcc", "cc", "g++", "c++"].includes(cmd) && a.length) {
      // handled by sibling attachment; wandbox compiles all .c/.cpp files listed in options
      for (const x of a) if (!x.startsWith("-") && x !== a.find(y => !y.startsWith("-")) && /\.(c|cc|cpp)$/.test(x)) compilerOpts.push(x);
    }

    const payload = { compiler: runner.compiler, code: mainCode, codes, stdin: stdin || "", save: false };
    if (compilerOpts.length) payload["compiler-option-raw"] = compilerOpts.join("\n");
    if (progArgs.length) payload["runtime-option-raw"] = progArgs.join("\n");

    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(WANDBOX, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
      if (!res.ok) return fail(`sandbox error: HTTP ${res.status}`);
      const d = await res.json();
      const code = parseInt(d.status ?? "0") || 0;
      const compileErr = d.compiler_error ? `[compiler]\n${d.compiler_error}\n` : "";
      return { out: d.program_output || "", err: compileErr + (d.program_error || ""), code: d.signal ? 139 : code };
    } catch (e) {
      return fail(`sandbox ${e.name === "AbortError" ? "timeout (20s)" : "error: " + e.message}`);
    } finally { clearTimeout(tm); }
  }
}

const BUILTINS = new Set(["cd", "ls", "cat", "echo", "pwd", "mkdir", "rm", "cp", "mv", "grep", "find", "sed", "head", "tail", "wc", "sort", "uniq", "tee", "tree", "curl", "touch", "diff", "send"]);

export const HELP = `Virtual terminal (workspace saved in the cloud, per user). Home: ${HOME}
File:   ls [-la] cd pwd cat [-n] mkdir -p touch rm [-rf] cp [-r] mv head tail wc sort uniq tee tree find diff
Text:   grep [-inrvcl] sed (s/a/b/g, -n 'N,Mp', -i) echo printf  (pipes |, &&, ||, ;, >, >>, heredoc <<'EOF', $VAR, $(cmd), globs *)
Net:    curl [-X M -H h -d data -o file] <url>
Run:    node python3 bash ruby php lua perl gcc g++ go run rustc tsc  (executed on a remote sandbox, no pip/npm install)
Send:   send <file> [caption]   -> uploads the file to the Telegram chat
`;
