// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers (exact, trailing-whitespace-insensitive, leading-and-trailing-whitespace-insensitive), and writes
// every change or none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
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
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 5: matching lines, and the shared line plumbing ----

interface FileParts {
  lines: string[];
  br: string;
  ends: boolean;
}

/** Split a file's text into its lines, its line break and whether it ends with one (section 3). */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function joinFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.ends ? parts.br : '');
}

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** 0-based positions where O occurs in lines at or after `from`, at the given tier. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  outer: for (let i = from; i + o.length <= lines.length; i++) {
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) continue outer;
    }
    out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: its text, and for a context line its index in O. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines for a match at `pos`: a context line is written as the file's own
 * matched line; at tier 2 every other non-blank line is re-indented from O's first line's leading
 * whitespace to the file's first matched line's (section 5).
 */
function buildN(n: NLine[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(o[0] ?? '');
  for (const item of n) {
    if (item.ctx !== null) {
      out.push(fileLines[pos + item.ctx]!);
      continue;
    }
    const t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoNL: boolean;
}

interface BodyItem {
  kind: string;
  text: string;
  noNL: boolean;
}

interface Section {
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  diffOld: string | undefined;
  diffNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, /dev/null as null. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const s = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2);
  return s;
}

function unifiedEdits(lines: string[], strict: boolean, moves: { from: string; to: string }[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;
  let body: BodyItem[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;

  const closeHunk = (): void => {
    if (hunk === null || cur === null) return;
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.kind === ' ' && last.text === '') body.pop();
      else break;
    }
    const o: string[] = [];
    const n: NLine[] = [];
    for (const b of body) {
      if (b.kind === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: o.length - 1 });
      } else if (b.kind === '-') o.push(b.text);
      else if (b.kind === '+') n.push({ text: b.text, ctx: null });
    }
    let noNL = false;
    for (let k = body.length - 1; k >= 0; k--) {
      const b = body[k]!;
      if (b.kind === ' ' || b.kind === '+') {
        noNL = b.noNL;
        break;
      }
    }
    let lastPlusNoNL = false;
    for (let k = body.length - 1; k >= 0; k--) {
      const b = body[k]!;
      if (b.kind === '+') {
        lastPlusNoNL = b.noNL;
        break;
      }
    }
    hunk.o = o;
    hunk.n = n;
    hunk.noNL = noNL;
    hunk.lastPlusNoNL = lastPlusNoNL;
    cur.hunks.push(hunk);
    hunk = null;
    body = [];
  };

  const startSection = (s: Section): void => {
    cur = s;
    sections.push(s);
    inHeader = true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      // A `--- ` line followed by a `+++ ` line ends the body: it starts a new section, even
      // though it also looks like an old line (it starts with `-`).
      const isNewSectionPair = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
      if (!isNewSectionPair && (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\')) {
        if (line[0] === '\\') {
          if (body.length > 0) body[body.length - 1]!.noNL = true;
        } else if (line === '') body.push({ kind: ' ', text: '', noNL: false });
        else body.push({ kind: line[0]!, text: line.slice(1), noNL: false });
        i++;
        continue;
      }
      closeHunk();
      inHeader = false;
      // Fall through and read this line outside the body.
    }
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({
        hasPair: false,
        pairOld: null,
        pairNew: null,
        diffOld: m[1]!,
        diffNew: m[2]!,
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        deletedFile: false,
        hunks: [],
      });
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      } else {
        startSection({
          hasPair: true,
          pairOld: oldP,
          pairNew: newP,
          diffOld: undefined,
          diffNew: undefined,
          renameFrom: undefined,
          renameTo: undefined,
          newFile: false,
          deletedFile: false,
          hunks: [],
        });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (cur === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), o: [], n: [], noNL: false, lastPlusNoNL: false };
      body = [];
      inHeader = false;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (hunk !== null) closeHunk();
  return sections.map((s) => sectionEdit(s, strict, moves));
}

/** Apply a section's hunks in order to a file's text (section 6). */
function applyHunksToText(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const hit = findTier(parts.lines, h.o, strict);
      if (hit === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = hit.occ[0]!;
      let best = Math.abs(pos - target);
      for (const p of hit.occ) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          pos = p;
        }
      }
      const atEnd = pos + h.o.length === parts.lines.length;
      const repl = buildN(h.n, parts.lines, pos, h.o, hit.tier);
      parts.lines.splice(pos, h.o.length, ...repl);
      if (atEnd) parts.ends = !h.noNL;
    } else {
      const ins = Math.max(0, Math.min(h.a + d, parts.lines.length));
      const atEnd = ins === parts.lines.length;
      const repl = h.n.map((x) => x.text);
      parts.lines.splice(ins, 0, ...repl);
      if (atEnd) parts.ends = !h.noNL;
    }
    d += h.n.length - h.o.length;
  }
  return joinFile(parts);
}

function sectionEdit(sec: Section, strict: boolean, moves: { from: string; to: string }[]): Edit {
  const oldP: string | null | undefined = sec.hasPair ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP: string | null | undefined = sec.hasPair ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const creation = oldP === null || sec.newFile;
  const deletion = !creation && (newP === null || sec.deletedFile);
  const isMove =
    !creation && !deletion && oldP !== undefined && oldP !== null && newP !== undefined && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== undefined && oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== undefined && newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (creation) {
      if (newP === undefined || newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let hasPlus = false;
      let lastNoNL = false;
      for (const h of sec.hunks) {
        let hp = false;
        for (const item of h.n) {
          if (item.ctx === null) {
            plus.push(item.text);
            hp = true;
          }
        }
        if (hp) {
          hasPlus = true;
          lastNoNL = h.lastPlusNoNL;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (hasPlus && !lastNoNL ? '\n' : ''));
      return;
    }
    if (deletion) {
      if (oldP === undefined || oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const p = oldP as string;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove) {
      const np = newP as string;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunksToText(before, sec.hunks, strict, p);
      tree.now.set(np, out);
      tree.now.set(p, null);
      moves.push({ from: p, to: np });
    } else {
      tree.now.set(p, applyHunksToText(before, sec.hunks, strict, p));
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const parts = splitFile(cur);
    const hit = findTier(parts.lines, oldLines, strict);
    if (hit === null) throw new Fail('no-match', path);
    if (hit.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = hit.occ[0]!;
    const nItems: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildN(nItems, parts.lines, pos, oldLines, hit.tier);
    parts.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(parts));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: VChunk[],
  strict: boolean,
  moves: { from: string; to: string }[],
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const hit = findTier(parts.lines, [ch.anchor], strict, cursor);
        if (hit === null) throw new Fail('no-match', path);
        cursor = hit.occ[0]! + 1;
      }
      if (ch.o.length > 0) {
        const hit = findTier(parts.lines, ch.o, strict, cursor);
        if (hit === null) throw new Fail('no-match', path);
        let pos = hit.occ[0]!;
        if (ch.eof) {
          const ok = hit.occ.find((p) => p + ch.o.length === parts.lines.length);
          if (ok === undefined) throw new Fail('no-match', path);
          pos = ok;
        }
        const repl = buildN(ch.n, parts.lines, pos, ch.o, hit.tier);
        parts.lines.splice(pos, ch.o.length, ...repl);
        cursor = pos + repl.length;
      } else {
        const ins = ch.eof ? parts.lines.length : cursor;
        const repl = ch.n.map((x) => x.text);
        parts.lines.splice(ins, 0, ...repl);
        cursor = ins + repl.length;
      }
    }
    const out = joinFile(parts);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: { from: string; to: string }[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (blank(l)) fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        if (blank(lines[i]!)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      i++;
      const secLines: { text: string; num: number }[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        secLines.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.text.slice(13).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < secLines.length; idx++) {
        const { text: l, num } = secLines[idx]!;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          closeChunk();
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, o: [], n: [], eof: false };
          if (l === '') {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          } else if (l[0] === ' ') {
            cur.o.push(l.slice(1));
            cur.n.push({ text: l.slice(1), ctx: cur.o.length - 1 });
          } else if (l[0] === '-') cur.o.push(l.slice(1));
          else cur.n.push({ text: l.slice(1), ctx: null });
          continue;
        }
        throw new Exit2(`error: parse ${num}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
  const moves: { from: string; to: string }[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rTo = new Map<string, string>();
  for (const m of moves) {
    if (tree.original(m.from) !== null && tree.get(m.from) === null && tree.original(m.to) === null && tree.get(m.to) !== null) {
      rTo.set(m.to, m.from);
    }
  }
  const rFrom = new Set(rTo.values());
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rTo.has(p) || rFrom.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [to, from] of rTo) rows.push({ key: to, text: `R ${from} -> ${to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
