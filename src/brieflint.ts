import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface QuotedPath {
  token: string;
  relativePath: string;
  exists: boolean;
}

const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const FILE_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'cjs', 'conf', 'cpp', 'css', 'csv', 'db', 'gif', 'go', 'h', 'hpp',
  'html', 'ini', 'java', 'jpeg', 'jpg', 'js', 'json', 'jsonl', 'jsx', 'kt', 'kts', 'lock',
  'md', 'mjs', 'parquet', 'pdf', 'png', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'sqlite',
  'svg', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'wasm', 'webp', 'xml', 'yaml', 'yml', 'zsh',
]);
const WALK_SKIP = new Set(['node_modules', '.git', 'dist']);
const MAX_WALK_ENTRIES = 10_000;

function looksLikeRepoPath(token: string): boolean {
  // Inline commands normally contain spaces, while URLs, package specifiers, absolute paths,
  // shell expressions, globs, and angle-bracket templates are deliberately excluded. A leading
  // backslash is an escape sequence, never a path; dot-slash and dot-dot-slash module specifiers
  // are anchored to the importing file rather than the repository root. What remains must contain
  // a separator or end in a common repository file extension. The finite extension set keeps
  // dotted API identifiers such as opts.root from becoming phantom paths.
  if (!token || /\s/.test(token) || token.startsWith('-') || token.includes('*')) return false;
  if (/[<>$|={}]/.test(token) || token.startsWith('@')) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|~\/|[A-Za-z]:[\\/]|\\|\.\.?\/)/i.test(token)) return false;
  const hasSeparator = token.includes('/') || token.includes('\\');
  const extensionMatch = token.match(
    /(?:^|[\\/])[^.\\/][^\\/]*\.([A-Za-z][A-Za-z0-9_-]{0,15})$/,
  );
  const extension = extensionMatch?.[1].toLowerCase();
  const hasExtension = extension !== undefined && FILE_EXTENSIONS.has(extension);
  return hasSeparator || hasExtension;
}

function quotedPaths(briefText: string, root: string): QuotedPath[] {
  const rootPath = resolve(root);
  const found = new Map<string, QuotedPath>();
  let inFence = false;

  for (const line of briefText.split(/\r?\n/)) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence && /^\s*[+-]/.test(line)) continue;

    for (const match of line.matchAll(/`([^`\r\n]+)`/g)) {
      const token = match[1];
      if (!looksLikeRepoPath(token) || found.has(token)) continue;

      const resolvedPath = resolve(rootPath, token);
      const underRoot = relative(rootPath, resolvedPath);
      const isUnderRoot = underRoot === ''
        || (underRoot !== '..' && !underRoot.startsWith(`..${sep}`) && !isAbsolute(underRoot));
      const relativePath = isUnderRoot ? relative(rootPath, resolvedPath) || '.' : token;
      found.set(token, {
        token,
        relativePath,
        exists: isUnderRoot && existsSync(resolvedPath),
      });
    }
  }

  return [...found.values()];
}

// Prose units for the rule-shaped checks: blank-line-delimited paragraphs, each bullet its own
// unit, fenced blocks blanked (a brief may QUOTE a banned shape inside an example fence).
function proseUnits(briefText: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => { if (current.length) units.push(current.join('\n')); current = []; };
  for (const line of briefText.split(/\r?\n/)) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) { inFence = !inFence; flush(); continue; }
    if (inFence || !line.trim()) { flush(); continue; }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) flush();
    current.push(line);
  }
  flush();
  return units;
}

// "Where they disagree, the spec wins" delegates requirement adjudication to the implementer:
// on every divergence each side resolves it its own way and the judges split along the same
// line (duel 258). A precedence verb alone ("the spec takes precedence") is a single-authority
// statement and stays legal — only the conflict clause makes it a runtime rule.
const CONFLICT_CLAUSE = /\b(?:disagree|conflict|diverge|contradict|inconsisten)/i;
const PRECEDENCE_VERB = /\b(?:wins?\b|prevails?\b|takes?\s+precedence|is\s+authoritative|defers?\s+to|deferred\s+to)/i;

// The tag is the judge-calibration instrument (v2.13.32): [PROCESS] violations cost grade
// notches only; untagged, one judge reads every brief rule as bar and under the intersection
// rule the stricter judge decides every contest (258 and 263 convicted trees graded A-/B+).
// A "rule" here is any unit inside a rules-headed section, plus any unit anywhere that carries
// a verdict tooth (FORBIDDEN / automatic FAIL) — teeth are uppercase by brief convention.
const RULE_TAG = /\[(?:BAR|PROCESS)\]/;
const MANDATE_TOOTH = /\b[Aa]utomatic(?:ally)?\s+(?:integrity[\s-])?FAIL\b|\bFORBIDDEN\b/;

// A section ends at the next heading of the SAME OR HIGHER level, not at any heading: a
// `###` under a `## D2 [BAR]` heading is part of D2, and ending there dropped every BAR-unit
// rule below it — the nested fixture linted clean while the same text flattened tripped the
// null-family rule (duel 391 M4).
const headingLevel = (line: string): number => /^\s{0,3}(#{1,6})\s/.exec(line)?.[1].length ?? 0;
function sectionText(briefText: string, heading: RegExp): string {
  const lines = briefText.split(/\r?\n/);
  // The first heading line is the brief's title, never a section head: a title that mentions
  // "rules" in passing turned everything below it into a rules section (duels 415, 416).
  const titleIndex = lines.findIndex(l => HEADING.test(l));
  const sections: string[] = [];
  for (let start = 0; start < lines.length; start++) {
    if (start === titleIndex) continue;
    if (!HEADING.test(lines[start]) || !heading.test(lines[start])) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (HEADING.test(lines[i]) && headingLevel(lines[i]) <= headingLevel(lines[start])) {
        end = i; break;
      }
    }
    sections.push(lines.slice(start + 1, end).join('\n'));
  }
  return sections.join('\n\n');
}

// The [BAR] surface of a brief: every unit carrying an inline [BAR] tag, plus every unit
// inside a section whose heading carries one (house style tags whole deliverable sections:
// "## D2 [BAR] — MSPD extension").
function barUnits(briefText: string): string[] {
  const tagged = new Set(proseUnits(sectionText(briefText, /\[BAR\]/)));
  for (const unit of proseUnits(briefText)) {
    if (/\[BAR\]/.test(unit)) tagged.add(unit);
  }
  return [...tagged];
}

function snippetOf(unit: string): string {
  const flat = unit.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

function hasBlockedScopeBoundary(briefText: string): boolean {
  const lines = briefText.split(/\r?\n/);
  const hatchLines = lines.flatMap((line, index) => /BLOCKED-SCOPE/i.test(line) ? [index] : []);
  if (!hatchLines.length) return true;

  return hatchLines.some(index => {
    const nearStart = Math.max(0, index - 3);
    const nearEnd = Math.min(lines.length, index + 4);
    if (/\bdeliverable\b/i.test(lines.slice(nearStart, nearEnd).join('\n'))) return true;

    let paragraphStart = index;
    let paragraphEnd = index + 1;
    while (paragraphStart > 0 && lines[paragraphStart - 1].trim()) paragraphStart--;
    while (paragraphEnd < lines.length && lines[paragraphEnd].trim()) paragraphEnd++;
    return /\bdeliverable\b/i.test(lines.slice(paragraphStart, paragraphEnd).join('\n'));
  });
}

function allowlistRegion(briefText: string): string {
  const lines = briefText.split(/\r?\n/);
  const structured = lines.flatMap((line, index) =>
    /^\s*(?:#{1,6}\s+|\*{0,2})?(?:scope\s+)?allowlist\b/i.test(line) ? [index] : []);
  const fallback = lines.findIndex(line => /\ballowlist\b/i.test(line));
  const markers = structured.length ? structured : fallback >= 0 ? [fallback] : [];

  return markers.map(start => {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (HEADING.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start, end).join('\n');
  }).join('\n');
}

function scopeOrAllowlistRegion(briefText: string): string {
  const lines = briefText.split(/\r?\n/);
  const sections: string[] = [];
  for (let start = 0; start < lines.length; start++) {
    if (HEADING.test(lines[start]) && /\b(?:scope|allowlist)\b/i.test(lines[start])) {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (HEADING.test(lines[i])) { end = i; break; }
      }
      sections.push(lines.slice(start, end).join('\n'));
      continue;
    }
    if (/^\s*(?:scope|allowlist)\s*:/i.test(lines[start])) {
      let end = start + 1;
      while (end < lines.length && lines[end].trim()) end++;
      sections.push(lines.slice(start, end).join('\n'));
    }
  }
  return sections.join('\n');
}

// A typoed relative spelling may still name a real file by basename (for example duel.ts when
// the repository holds src/duel.ts). Bound the fallback so linting an unexpectedly huge tree
// cannot become an unbounded pre-flight, and never descend into generated/vendor metadata trees.
function findBasenames(root: string, wanted: string): string[] {
  const pending = [''];
  const matches: string[] = [];
  let visited = 0;
  while (pending.length && visited < MAX_WALK_ENTRIES) {
    const relativeDir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, relativeDir), { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { continue; }
    for (const entry of entries) {
      if (++visited > MAX_WALK_ENTRIES) break;
      const relativePath = join(relativeDir, entry.name);
      if (entry.isFile() && entry.name === wanted) matches.push(relativePath);
      if (entry.isDirectory() && !WALK_SKIP.has(entry.name)) pending.push(relativePath);
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

export function lintBrief(
  briefText: string,
  opts: { root: string },
): { findings: string[]; sha256: string } {
  const findings: string[] = [];
  const sha256 = createHash('sha256').update(briefText).digest('hex');

  if (!briefText.trim()) findings.push('brief is empty or whitespace-only');
  if (!/^\s*(?:#{1,6}\s+|\*{0,2})?deliverables?\b\s*(?::|\*{0,2}\s*$)/im.test(briefText)) {
    findings.push('brief has no Deliverables heading or label');
  }
  if (!/\ballowlist\b/i.test(briefText)) findings.push('brief has no allowlist marker');
  if (!/\b(?:file[-\s]+level|api[-\s]+surface|public\s+surface)\b/i.test(briefText)) {
    findings.push('scope clause names no level (file-level vs API-surface) — '
      + 'judges split on unleveled scope (duel 211)');
  }
  if (!hasBlockedScopeBoundary(briefText)) {
    findings.push('BLOCKED-SCOPE hatch without its boundary — '
      + 'the hatch swallows the whole task on any brief defect (duels 210, 212)');
  }
  // Lines the SKILL pre-flight makes every brief carry verbatim (duel 391 M17). The two
  // unconditional ones are refused outright; the two conditional on the brief's kind read the
  // kind off the title and only warn — a title is a heuristic, not a declaration.
  if (!/\bONE simple command\b/i.test(briefText)) {
    findings.push('brief lacks the simple-command line ("Run each shell check as ONE simple '
      + 'command …") — lane B is gated by command shape, so every compound form it reaches for '
      + 'is a denied check its opponent runs for free (duels 202, 205, 208)');
  }
  if (!/names the command you actually ran/i.test(briefText)) {
    findings.push('brief lacks the method-naming line ("Every verification claim names the '
      + 'command you actually ran, verbatim …") — a method named but never invoked drew an '
      + 'integrity FAIL that had to be retracted (duel 208)');
  }
  // Operator mandate 2026-09-03: a serena-equipped lane navigates code with serena. Measured
  // the same day, lane B had called it in 3 of 425 sessions — a server every side pays to
  // start and never touches unless the brief says so.
  if (!/Navigate code with serena/i.test(briefText)) {
    findings.push('brief lacks the serena line ("Navigate code with serena: …") — without it a '
      + 'serena-equipped side never touches the server it started (3 of 425 lane-B sessions '
      + 'called it before the 2026-09-03 mandate)');
  }
  // Operator, 2026-09-03: fan-out is a lane capability both sides have, and only the brief
  // invites it. Codex fans out on its own (48 of 59 implementation-build duels with a known
  // count, winning 29–14 there against 3–7 solo); lane B did in 0 of 113 until told to — the
  // web-research union brief says so and duel 257's B side ran six sub-agents.
  if (!/fan out\s+sub-agents/i.test(briefText)) {
    findings.push('brief lacks the fan-out line ("You may fan out sub-agents on distinct '
      + 'subtasks …") — without it the Claude side never fans out while codex does on its own '
      + '(implementation-build: lane B 0 of 113, codex 48 of 59 known, winning 29–14 there)');
  }
  const title = briefText.split(/\r?\n/).find(l => HEADING.test(l)) ?? '';
  if (/\bmutating\b/i.test(title) && !/\bIMPOSSIBLE-FIXTURE\b/.test(briefText)) {
    findings.push('warn: mutating brief (per its title) carries no IMPOSSIBLE-FIXTURE hatch — '
      + 'without "Fixture/test impossible as specified → STOP and report IMPOSSIBLE-FIXTURE" '
      + 'a side adapts production code to a broken fixture (duels 78, 196)');
  }
  const RUBRIC = /\bP0\b[\s\S]{0,200}?\bP1\b[\s\S]{0,300}?\bP2\b[\s\S]{0,300}?\bP3\b/;
  if (/\breview\b/i.test(title) && !RUBRIC.test(briefText)) {
    findings.push('warn: review brief (per its title) carries no severity rubric — without the '
      + 'P0/P1/P2/P3 clauses each side self-grades by confidence, and a union ships unjudged '
      + '(duel 207)');
  }
  if (proseUnits(briefText).some(u => CONFLICT_CLAUSE.test(u) && PRECEDENCE_VERB.test(u))) {
    findings.push('brief ships a runtime precedence rule — reconcile each divergence into the '
      + 'brief itself before minting; left to runtime, each side resolves the conflict its own '
      + 'way and the judges split along it (duel 258)');
  }
  const untaggedRules = new Set<string>();
  for (const unit of proseUnits(sectionText(briefText, /\brules?\b/i))) {
    if (!RULE_TAG.test(unit)) untaggedRules.add(unit);
  }
  for (const unit of proseUnits(briefText)) {
    if (MANDATE_TOOTH.test(unit) && !RULE_TAG.test(unit)) untaggedRules.add(unit);
  }
  for (const unit of untaggedRules) {
    findings.push(`rule carries no [BAR]/[PROCESS] tag: "${snippetOf(unit)}" — untagged, the `
      + 'stricter judge reads it as bar and decides the contest (duels 258, 263)');
  }
  // A structural pin ("row 4 col0") is read 0-based by one party and 1-based by another,
  // moving every downstream assertion by one — and the side has no network to re-derive the
  // layout (duel 283: the side anchored by content and disclosed; one judge convicted the
  // anchor, the other graded it a formality, and the duel contested). One declaration line
  // anywhere in the brief clears every pin.
  const INDEX_BASE = /\b(?:[01][\s-]based|zero[\s-]based|one[\s-]based)\b/i;
  if (!INDEX_BASE.test(briefText)) {
    for (const unit of proseUnits(briefText)) {
      // Singular only: "rows 13 apart" / "887 rows" are spacing and count phrases, not pins.
      const pin = unit.match(/\b(?:row|col|column)(?:\s+index)?\s*#?\d+\b/i);
      if (pin) {
        findings.push(`brief pins structural indices ("${pin[0]}") without declaring the base — `
          + '0-based vs 1-based split a side and a judge on the header location (duel 283)');
        break;
      }
    }
  }
  // "A non-null X throws" gates on the COMPLEMENT of an absent family the brief never
  // enumerates: one side reads JS null, the other the file's full absent-encoding set,
  // the judges inherit the two readings and split head-on (duel 289 F3: the literal
  // reading hard-threw on 13 real-payload rows carrying the string "null"). Straight-quoted
  // short literals in the unit count as the enumeration; the cap keeps prose apostrophes
  // from pairing into a phantom literal.
  const NEGATED_FAMILY = /\bnon[-\s]?(?:null|empty|blank|missing|absent)\b|\bnot\s+(?:null|empty|blank|missing|absent)\b/i;
  const GATE_VERB = /\bthrows?\b|\bskip(?:s|ped)?\b|\bdrop(?:s|ped)?\b|\breject|\bfail|\bexclude/i;
  const ENUM_LITERAL = /"[^"\n]{0,12}"|'[^'\n]{0,12}'/;
  // The split is about DATA: a cell/field/value read from a file or payload has an absent
  // family to enumerate. "A non-empty NOT RUN list without reasons fails the report" negates a
  // report section, and blocking it made the rule a false gate (duel 391 M17) — no data-field
  // noun after the negation demotes the finding to warn.
  const DATA_FIELD_NOUN = /\b(?:cell|field|value|column|row|entry|key|propert(?:y|ies)|attribute|element|payload|record|string|number|date|item|object|array)s?\b/i;
  for (const unit of barUnits(briefText)) {
    const negation = NEGATED_FAMILY.exec(unit);
    if (!negation || !GATE_VERB.test(unit)) continue;
    // The enumeration must sit BESIDE the negation: a quoted literal elsewhere in the unit
    // (a reviewer-verbatim date, an example value) is evidence, not the absent family.
    if (ENUM_LITERAL.test(unit.slice(negation.index, negation.index + 200))) continue;
    const after = unit.slice(negation.index + negation[0].length);
    const noun = after.slice(0, Math.min(GATE_VERB.exec(after)?.index ?? after.length, 60)).trim();
    if (!DATA_FIELD_NOUN.test(noun)) {
      findings.push(`warn: negated null-family gate over "${noun}" — no data-field noun follows `
        + 'the negation, so the encoding-family split (duel 289) may not apply; enumerate the '
        + `absent encodings beside it if it does (duel 391 M17): "${snippetOf(unit)}"`);
      continue;
    }
    findings.push(`negated null-family gate without its encoding family: "${snippetOf(unit)}" — `
      + '"non-null X throws" makes each side pick its own absent set (JS null vs the file\'s '
      + '"null" / "" / "*"); enumerate the encodings in the unit (duel 289)');
  }
  // Positive presence gates have the same absent-family ambiguity: duel 414 split JS
  // truthiness from SQL NULL on a bare "when X is present". A nearby straight-quoted
  // literal pins the family; without a preceding data-field noun or token, the rule only
  // warns because the gate may describe prose rather than data.
  const PRESENCE_GATE = /\b(?:is|are|was|were|when|if|where|whenever|unless|while)\s+(?:present|absent|missing|null|empty|blank)\b/gi;
  const FIELD_TOKEN = /`[\w.$-]+`/;
  for (const unit of barUnits(briefText)) {
    for (const gate of unit.matchAll(PRESENCE_GATE)) {
      const at = gate.index ?? 0;
      if (ENUM_LITERAL.test(unit.slice(Math.max(0, at - 200), at + gate[0].length + 200))) continue;
      const before = unit.slice(Math.max(0, at - 60), at);
      findings.push(DATA_FIELD_NOUN.test(before) || FIELD_TOKEN.test(before)
        ? `presence gate without its encoding family: "${snippetOf(unit)}" — "when X is present" reads JS truthiness on one side and SQL NULL on the other; enumerate the absent encodings beside each gated field (duel 414)`
        : `warn: presence gate with no data field before it — the encoding-family split (duel 414) may not apply; enumerate the absent encodings beside it if it does: "${snippetOf(unit)}"`);
      break;
    }
  }
  // "Clone the shape those rows use" pins nothing: each side reads the reference its own
  // way (283 D4: one side cloned the full sibling row, the other shipped six of eleven
  // fields; 289 F1: "clone its shape where the API supports them" left payload_sha unstamped
  // behind a false impossibility claim). The directive either enumerates the members or
  // explicitly delegates the unpinned part as disclosed side-judgment.
  const CLONE_POINTER = /\b(?:clone|mirror|cop(?:y|ies))\b[^\n.]{0,80}\b(?:shape|structure|schema|pattern)\b|\b(?:shape|structure|schema|pattern)\b[^\n.]{0,40}\bclone\b|\bsame\s+(?:shape|structure|schema|pattern)\s+as\b/i;
  const CLONE_ESCAPE = /\bdisclose\b|\bside[-\s]judgment\b|\byour\s+(?:choice|judgment)\b|\bcomplete\s+(?:list|enumeration)\b|\bunpinned\b/i;
  for (const unit of barUnits(briefText)) {
    if (CLONE_POINTER.test(unit) && !CLONE_ESCAPE.test(unit)) {
      findings.push(`clone-by-pointer without an acceptance surface: "${snippetOf(unit)}" — `
        + '"clone the shape" hands the member list to each side\'s reading of the reference '
        + '(duels 283 D4, 289 F1); enumerate the members ("complete list: …") or mark the '
        + 'unpinned part side-judgment with "disclose"');
    }
  }
  // A deliverable the destination lane's permission profile cannot PRODUCE (file modes are
  // denied on lane B) moves to the brief's declared controller-side execution list — left on
  // the side, the denial converts into a quality conviction (261: the missing 755 bit was the
  // single reason both judges failed an honest side; 258 lost a notch the same way).
  const EXEC_BIT = /\bchmod\b|\bexecutable[-\s](?:bit|mode|permission)|\bmode\s+(?:bits?\b|0?o?[0-7]{3}\b)/i;
  const controllerRegion = sectionText(briefText, /controller/i);
  for (const unit of proseUnits(briefText)) {
    // A quoted span is a reference, not a requirement: a test-row name that carries the verb, or the
    // finding text itself quoted in a brief about the lint (duel 417). Single quotes stay live on
    // purpose — an apostrophe would open a span that swallows the requirement after it.
    if (!EXEC_BIT.test(unit.replace(/`[^`\n]*`|"[^"\n]*"/g, ' '))) continue;
    if (/controller[-\s]side/i.test(unit) || controllerRegion.includes(unit)) continue;
    findings.push('executable-bit requirement outside a controller-side execution list: '
      + `"${snippetOf(unit)}" — a lane that cannot set file modes converts the denial into a `
      + 'quality conviction (duels 258, 261)');
  }

  const paths = quotedPaths(briefText, opts.root);
  const basenameMatches = new Map<string, string | null>();
  for (const path of paths) {
    if (!path.exists) {
      const name = basename(path.token.replaceAll('\\', '/'));
      if (!basenameMatches.has(name)) {
        basenameMatches.set(name, findBasenames(resolve(opts.root), name)[0] ?? null);
      }
      const alternative = basenameMatches.get(name);
      findings.push(alternative
        ? `warn: brief quotes \`${path.token}\` which does not exist under ${opts.root} — `
          + `did you mean \`${alternative}\`?`
        : `brief quotes \`${path.token}\` which does not exist under ${opts.root} — `
          + 'the duel-210 phantom-requirement class');
    }
  }

  // Allowlist entries are exact paths (duel 391 M6): substring membership admitted `src/tool.ts`
  // against `src/tool.ts.bak`, and the basename fallback admitted `hooks/hooks.json` against
  // `config/hooks.json`. A bare basename admits a file only when it names exactly one.
  const entries = allowlistRegion(briefText).replace(/`/g, ' ').split(/[\s,;()]+/)
    .map(w => w.replace(/[.:]+$/, '')).filter(Boolean);
  const uniqueByName = new Map<string, string | null>();
  const admits = (entry: string, path: QuotedPath): boolean => {
    if (entry === path.token || entry === path.relativePath) return true;
    if (entry.includes('/') || entry !== basename(path.relativePath)) return false;
    if (!uniqueByName.has(entry)) {
      const m = findBasenames(resolve(opts.root), entry);
      uniqueByName.set(entry, m.length === 1 ? m[0] : null);
    }
    return uniqueByName.get(entry) === path.relativePath;
  };
  const readScopeDeclared = /read/i.test(scopeOrAllowlistRegion(briefText));
  for (const path of paths) {
    if (!path.exists) continue;
    const allowed = entries.some(e => admits(e, path));
    if (!allowed) {
      findings.push(`warn: brief quotes existing file \`${path.token}\` outside its own allowlist — `
        + (readScopeDeclared
          ? 'read scope declared — likely fine'
          : "say whether it is in scope (duel 210's shape)"));
    }
  }

  return { findings, sha256 };
}
