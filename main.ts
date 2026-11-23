// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON tool-call edits), applies its edits to the tree under the working directory with
// three-tier line matching, and writes every change or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}
const parseError = (n: number): Exit2 => new Exit2(`error: parse ${n}`);

const blank = (s: string): boolean => s.trim() === '';
/** Surrounding spaces (only spaces) removed. */
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function checkSafe(...paths: string[]): void {
  for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------------------------------------------------------
// Files as lines (SPEC.md section 3)

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function toLines(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fromLines(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A new file: LF breaks, a final break unless told otherwise; no lines is empty. */
function newFile(lines: string[], final = true): string {
  return lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : '');
}

// ---------------------------------------------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)

const TIERS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

/** Positions i at which `old` matches `file` at `tier`, filtered by `ok`. */
function occurrencesAt(file: string[], old: string[], tier: number, ok: (i: number) => boolean): number[] {
  const norm = TIERS[tier]!;
  const o = old.map(norm);
  const f = file.map(norm);
  const out: number[] = [];
  for (let i = 0; i + o.length <= f.length; i += 1) {
    if (!ok(i)) continue;
    let all = true;
    for (let j = 0; j < o.length; j += 1) {
      if (f[i + j] !== o[j]) {
        all = false;
        break;
      }
    }
    if (all) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs (among positions `ok` accepts), with its occurrences; null when none. */
function findTier(file: string[], old: string[], strict: boolean, ok: (i: number) => boolean = () => true): { tier: number; at: number[] } | null {
  const last = strict ? 0 : 2;
  for (let tier = 0; tier <= last; tier += 1) {
    const at = occurrencesAt(file, old, tier, ok);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A body line of a hunk or chunk: context, old, new. */
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

const oldOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind !== '+').map((b) => b.text);

const leading = (s: string): string => /^[ \t]*/.exec(s)![0];

/** N for a match of the body's O at position `i` of `file`, at `tier`. */
function newOf(body: BodyLine[], file: string[], i: number, tier: number): string[] {
  const firstOld = body.find((b) => b.kind !== '+');
  const P = firstOld === undefined ? '' : leading(firstOld.text);
  const F = firstOld === undefined ? '' : leading(file[i] ?? '');
  const out: string[] = [];
  let k = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(file[i + k]!);
      k += 1;
    } else if (b.kind === '-') {
      k += 1;
    } else if (tier === 2 && firstOld !== undefined && b.text.trim() !== '' && b.text.startsWith(P)) {
      out.push(F + b.text.slice(P.length));
    } else {
      out.push(b.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The tree (SPEC.md section 10)

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Ctx {
  strict: boolean;
}

type Edit = (tree: Tree, ctx: Ctx) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)

interface Hunk {
  a: number;
  body: BodyLine[];
  /** For each body line, whether a `\` line follows it. */
  noEol: boolean[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newMode: boolean;
  deletedMode: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

const DEV_NULL = '/dev/null';

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = trimSpaces(p);
  if (p === DEV_NULL) return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const splits: number[] = [];
  for (let k = rest.indexOf(' b/'); k >= 0; k = rest.indexOf(' b/', k + 1)) splits.push(k);
  if (splits.length === 0) return null;
  for (const k of splits) {
    const x = rest.slice(2, k);
    const y = rest.slice(k + 3);
    if (x === y) return [x, y];
  }
  const k = splits[0]!;
  return [rest.slice(2, k), rest.slice(k + 3)];
}

const isPair = (lines: string[], i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (): Section => ({ gitOld: null, gitNew: null, minus: null, plus: null, renameFrom: null, renameTo: null, newMode: false, deletedMode: false, hasPair: false, hunks: [] });
  const inHeader = (): boolean => cur !== null && cur.hunks.length === 0;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const p = gitPaths(l);
      if (p === null) throw parseError(i + 1);
      cur = fresh();
      cur.gitOld = p[0];
      cur.gitNew = p[1];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (isPair(lines, i)) {
      if (!(inHeader() && !cur!.hasPair)) {
        cur = fresh();
        sections.push(cur);
      }
      cur!.minus = headerPath(l);
      cur!.plus = headerPath(lines[i + 1]!);
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null || cur === null) throw parseError(i + 1);
      const body: BodyLine[] = [];
      const noEol: boolean[] = [];
      let j = i + 1;
      let end = j; // one past the last body line that is not a trailing empty line
      const raw: string[] = [];
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || isPair(lines, j)) break;
        if (b !== '' && !' -+\\'.includes(b[0]!)) break;
        raw.push(b);
        j += 1;
        if (b !== '') end = j;
      }
      raw.length = end - (i + 1);
      for (const b of raw) {
        if (b.startsWith('\\')) {
          if (noEol.length > 0) noEol[noEol.length - 1] = true;
          continue;
        }
        const kind = (b === '' ? ' ' : b[0]) as ' ' | '-' | '+';
        body.push({ kind, text: b.slice(1) });
        noEol.push(false);
      }
      cur.hunks.push({ a: Number(m[1]), body, noEol });
      i = j;
      continue;
    }
    if (inHeader()) {
      const s = cur!;
      if (l.startsWith('--- ')) throw parseError(i + 2);
      if (l.startsWith('rename from ')) s.renameFrom = trimSpaces(l.slice('rename from '.length));
      else if (l.startsWith('rename to ')) s.renameTo = trimSpaces(l.slice('rename to '.length));
      else if (l.startsWith('new file mode')) s.newMode = true;
      else if (l.startsWith('deleted file mode')) s.deletedMode = true;
    }
    i += 1;
  }
  return sections.map(sectionEdit);
}

function sectionEdit(s: Section): Edit {
  const oldP = s.hasPair ? s.minus! : (s.renameFrom ?? s.gitOld ?? '');
  const newP = s.hasPair ? s.plus! : (s.renameTo ?? s.gitNew ?? '');
  const creation = oldP === DEV_NULL || s.newMode;
  const deletion = !creation && (newP === DEV_NULL || s.deletedMode);
  return (tree, ctx) => {
    if (creation) {
      checkSafe(newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let final = true;
      for (const h of s.hunks) {
        h.body.forEach((b, k) => {
          if (b.kind !== '+') return;
          plus.push(b.text);
          final = !h.noEol[k];
        });
      }
      tree.now.set(newP, newFile(plus, final));
      return;
    }
    if (deletion) {
      checkSafe(oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const move = oldP !== newP;
    checkSafe(oldP);
    if (move) checkSafe(newP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    if (move && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = toLines(text);
    let d = 0;
    for (const h of s.hunks) {
      const O = oldOf(h.body);
      let lastN = -1;
      h.body.forEach((b, k) => {
        if (b.kind !== '-') lastN = k;
      });
      const noEolN = lastN >= 0 && h.noEol[lastN]!;
      let N: string[];
      let atEnd: boolean;
      if (O.length > 0) {
        const r = findTier(f.lines, O, ctx.strict);
        if (r === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let pos = r.at[0]!;
        for (const p of r.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
        N = newOf(h.body, f.lines, pos, r.tier);
        atEnd = pos + O.length === f.lines.length;
        f.lines.splice(pos, O.length, ...N);
      } else {
        N = h.body.map((b) => b.text);
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...N);
      }
      if (atEnd) f.final = !noEolN;
      d += N.length - O.length;
    }
    tree.now.set(newP, fromLines(f));
    if (move) {
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let regionStart = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= regionStart; k -= 1) {
      const l = lines[k]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw parseError(i + 1);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (rep < 0) throw parseError(i + 1);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(blockEdit(path, oldLines, newLines));
    prevPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function blockEdit(p: string, oldLines: string[], newLines: string[]): Edit {
  const body: BodyLine[] = [...oldLines.map((text) => ({ kind: '-' as const, text })), ...newLines.map((text) => ({ kind: '+' as const, text }))];
  return (tree, ctx) => {
    checkSafe(p);
    const text = tree.get(p);
    if (oldLines.length === 0) {
      if (text !== null) throw new Fail('exists', p);
      tree.now.set(p, newFile(newLines));
      return;
    }
    if (text === null) throw new Fail('missing', p);
    const f = toLines(text);
    const r = findTier(f.lines, oldLines, ctx.strict);
    if (r === null) throw new Fail('no-match', p);
    if (r.at.length > 1) throw new Fail('ambiguous', p);
    const pos = r.at[0]!;
    f.lines.splice(pos, oldLines.length, ...newOf(body, f.lines, pos, r.tier));
    tree.now.set(p, fromLines(f));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw parseError(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const kind = l.startsWith(ADD) ? 'add' : l.startsWith(DELETE) ? 'delete' : l.startsWith(UPDATE) ? 'update' : null;
    if (kind === null) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw parseError(i + 1);
    }
    const head = i;
    const path = trimSpaces(l.slice(kind === 'add' ? ADD.length : kind === 'delete' ? DELETE.length : UPDATE.length));
    let j = i + 1;
    while (j < last && !lines[j]!.startsWith(ADD) && !lines[j]!.startsWith(DELETE) && !lines[j]!.startsWith(UPDATE)) j += 1;
    let end = j;
    while (end > head + 1 && blank(lines[end - 1]!)) end -= 1;
    const body: [string, number][] = [];
    for (let k = head + 1; k < end; k += 1) body.push([lines[k]!, k + 1]);
    i = j;
    if (kind === 'add') {
      const out: string[] = [];
      for (const [t, n] of body) {
        if (t === '') out.push('');
        else if (t.startsWith('+')) out.push(t.slice(1));
        else throw parseError(n);
      }
      edits.push(addEdit(path, out));
    } else if (kind === 'delete') {
      if (body.length > 0) throw parseError(body[0]![1]);
      edits.push(deleteEdit(path));
    } else {
      let move: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0]![0].startsWith(MOVE)) {
        move = trimSpaces(body[0]![0].slice(MOVE.length));
        k = 1;
      }
      const chunks: Chunk[] = [];
      let c: Chunk | null = null;
      for (; k < body.length; k += 1) {
        const [t, n] = body[k]!;
        if (t.trim() === '*** End of File') {
          if (c === null) {
            if (chunks.length > 0) throw parseError(n);
            c = { anchor: null, body: [], eof: false };
          }
          c.eof = true;
          chunks.push(c);
          c = null;
        } else if (t.startsWith('@@')) {
          if (c !== null) chunks.push(c);
          const a = trimSpaces(t.slice(2));
          c = { anchor: a === '' ? null : a, body: [], eof: false };
        } else if (t === '' || ' -+'.includes(t[0]!)) {
          if (c === null) {
            if (chunks.length > 0) throw parseError(n);
            c = { anchor: null, body: [], eof: false };
          }
          c.body.push({ kind: (t === '' ? ' ' : t[0]) as ' ' | '-' | '+', text: t.slice(1) });
        } else throw parseError(n);
      }
      if (c !== null) chunks.push(c);
      if (chunks.length === 0 && move === null) throw parseError(head + 1);
      edits.push(updateEdit(path, move, chunks));
    }
  }
  return edits;
}

function addEdit(p: string, out: string[]): Edit {
  return (tree) => {
    checkSafe(p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, newFile(out));
  };
}

function deleteEdit(p: string): Edit {
  return (tree) => {
    checkSafe(p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function updateEdit(p: string, move: string | null, chunks: Chunk[]): Edit {
  return (tree, ctx) => {
    checkSafe(p);
    if (move !== null) checkSafe(move);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const f = toLines(text);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const r = findTier(f.lines, [c.anchor], ctx.strict, (i) => i >= cursor);
        if (r === null) throw new Fail('no-match', p);
        cursor = r.at[0]! + 1;
      }
      const O = oldOf(c.body);
      if (O.length === 0) {
        const N = c.body.map((b) => b.text);
        const at = c.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...N);
        cursor = at + N.length;
        continue;
      }
      const len = f.lines.length;
      const r = findTier(f.lines, O, ctx.strict, (i) => i >= cursor && (!c.eof || i + O.length === len));
      if (r === null) throw new Fail('no-match', p);
      const pos = r.at[0]!;
      const N = newOf(c.body, f.lines, pos, r.tier);
      f.lines.splice(pos, O.length, ...N);
      cursor = pos + N.length;
    }
    if (move !== null) {
      tree.now.set(move, fromLines(f));
      tree.now.set(p, null);
      tree.moves.push([p, move]);
    } else tree.now.set(p, fromLines(f));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    checkSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const f = toLines(exists(tree));
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, fromLines(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw parseError(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(v)) throw parseError(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw parseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw parseError(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// The command (SPEC.md sections 1, 2 and 10)

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw parseError(1);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { strict };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moves = tree.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const changed = new Map<string, string>();
  for (const [p, now] of tree.now) {
    const was = tree.original(p);
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: [string, string][] = [];
  for (const [o, n] of tree.moves) {
    if (changed.get(o) === 'D' && changed.get(n) === 'A') {
      changed.delete(o);
      changed.delete(n);
      rows.push([n, `R ${o} -> ${n}`]);
    }
  }
  for (const [p, c] of changed) rows.push([p, `${c} ${p}`]);
  rows.sort((a, b) => byteOrder(a[0], b[0]));

  if (!check) {
    for (const [p, now] of tree.now) if (now === null && tree.original(p) !== null) rmSync(p, { force: true });
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const now = tree.now.get(p)!;
      if (now === null || now === tree.original(p)) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r[1]), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
