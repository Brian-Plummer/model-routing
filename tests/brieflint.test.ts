import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintBrief } from '../src/brieflint.js';

const root = mkdtempSync(join(tmpdir(), 'mr-brieflint-'));
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'docs'), { recursive: true });
mkdirSync(join(root, '.review-scratch'), { recursive: true });
writeFileSync(join(root, 'src', 'tool.ts'), 'export const tool = true;\n');
writeFileSync(join(root, 'src', 'duel.ts'), 'export const duel = true;\n');
writeFileSync(join(root, 'docs', 'reference.md'), '# Reference\n');
writeFileSync(join(root, '.review-scratch', 'duel163-diff.patch'), 'fixture\n');
// duel 391 M6: two files sharing a basename, and a file whose name contains another's
mkdirSync(join(root, 'hooks'), { recursive: true });
mkdirSync(join(root, 'config'), { recursive: true });
writeFileSync(join(root, 'hooks', 'hooks.json'), '{}\n');
writeFileSync(join(root, 'config', 'hooks.json'), '{}\n');
writeFileSync(join(root, 'src', 'tool.ts.bak'), 'export const tool = false;\n');

const cleanBrief = `# Duel 245 fixture

## Deliverables

Create \`src/tool.ts\`.

## Scope — FILE LEVEL

Allowlist: \`src/tool.ts\`.

BLOCKED-SCOPE stops the build only when a DELIVERABLE cannot land inside the allowlist.

Every verification claim names the command you actually ran, verbatim.
Run each shell check as ONE simple command.
Navigate code with serena: open each source file with get_symbols_overview / find_symbol.
You may fan out sub-agents on distinct subtasks; name the count in your report.
`;

const fencedDiffBrief = cleanBrief + `
## Patch example

\`\`\`diff
+ add \`phantom/new-file.ts\`
- remove \`legacy/old-file.ts\`
\`\`\`
`;

const CASES: Array<{ name: string; brief: string; finding?: string }> = [
  {
    name: 'clean real-duel-shaped brief has no findings',
    brief: cleanBrief,
  },
  {
    name: 'duel-210 shape: quoted path does not exist under root',
    brief: cleanBrief.replace(/src\/tool\.ts/g, 'config/manifest.yaml'),
    finding: `brief quotes \`config/manifest.yaml\` which does not exist under ${root} — `
      + 'the duel-210 phantom-requirement class',
  },
  {
    name: 'bare basename that exists below root is warning-class with the real path',
    brief: cleanBrief.replace(/src\/tool\.ts/g, 'duel.ts'),
    finding: 'warn: brief quotes `duel.ts` which does not exist under '
      + `${root} — did you mean \`src/duel.ts\`?`,
  },
  {
    name: 'bare basename that exists nowhere remains a hard phantom finding',
    brief: cleanBrief.replace(/src\/tool\.ts/g, 'nowhere.ts'),
    finding: `brief quotes \`nowhere.ts\` which does not exist under ${root} — `
      + 'the duel-210 phantom-requirement class',
  },
  {
    name: 'scope clause names no level',
    brief: cleanBrief.replace('## Scope — FILE LEVEL', '## Scope'),
    finding: 'scope clause names no level (file-level vs API-surface) — '
      + 'judges split on unleveled scope (duel 211)',
  },
  {
    name: 'BLOCKED-SCOPE hatch has no boundary',
    brief: cleanBrief.replace(
      'BLOCKED-SCOPE stops the build only when a DELIVERABLE cannot land inside the allowlist.',
      'BLOCKED-SCOPE may stop the build.',
    ),
    finding: 'BLOCKED-SCOPE hatch without its boundary — '
      + 'the hatch swallows the whole task on any brief defect (duels 210, 212)',
  },
  {
    name: 'whitespace-only brief',
    brief: ' \n\t\n',
    finding: 'brief is empty or whitespace-only',
  },
  {
    name: 'existing file outside the allowlist is warning-class',
    brief: cleanBrief.replace(
      'Create `src/tool.ts`.',
      'Create `src/tool.ts`; consult `docs/reference.md`.',
    ),
    finding: "warn: brief quotes existing file `docs/reference.md` outside its own allowlist — "
      + "say whether it is in scope (duel 210's shape)",
  },
  {
    name: 'backtick paths on fenced diff add/remove lines are skipped',
    brief: fencedDiffBrief,
  },
  {
    name: 'duel-258 shape: runtime precedence rule over two documents',
    brief: cleanBrief + '\nWhere the plan and the spec disagree, the spec wins.\n',
    finding: 'brief ships a runtime precedence rule — reconcile each divergence into the brief '
      + 'itself before minting; left to runtime, each side resolves the conflict its own way '
      + 'and the judges split along it (duel 258)',
  },
  {
    name: 'precedence verb without a conflict clause is a single-authority statement, not flagged',
    brief: cleanBrief + '\nThe spec takes precedence as the sole requirements document.\n',
  },
  {
    name: 'precedence rule quoted inside a code fence is skipped',
    brief: cleanBrief + '\n```\nWhere the plan and the spec disagree, the spec wins.\n```\n',
  },
  {
    name: 'rules-section line without a [BAR]/[PROCESS] tag is flagged',
    brief: cleanBrief + '\n## Conduct rules\n\nRun each shell check as ONE simple command.\n',
    finding: 'rule carries no [BAR]/[PROCESS] tag: "Run each shell check as ONE simple command." '
      + '— untagged, the stricter judge reads it as bar and decides the contest (duels 258, 263)',
  },
  {
    name: 'tagged rules section is clean',
    brief: cleanBrief
      + '\n## Conduct rules\n\n[PROCESS] Run each shell check as ONE simple command.\n',
  },
  {
    name: 'untagged mandate tooth outside any rules section is flagged',
    brief: cleanBrief + '\nEditing any path outside the scope is FORBIDDEN.\n',
    finding: 'rule carries no [BAR]/[PROCESS] tag: "Editing any path outside the scope is '
      + 'FORBIDDEN." — untagged, the stricter judge reads it as bar and decides the contest '
      + '(duels 258, 263)',
  },
  {
    name: 'tagged mandate tooth outside a rules section is clean',
    brief: cleanBrief + '\n[BAR] Editing any path outside the scope is FORBIDDEN.\n',
  },
  {
    name: 'duel-415 shape: a title that mentions rules is not a rules section',
    brief: cleanBrief.replace('# Duel 245 fixture', '# Duel 245 fixture — two rules for the launcher'),
  },
  {
    name: 'a rules-headed section below such a title is still a rules section',
    brief: cleanBrief.replace('# Duel 245 fixture', '# Duel 245 fixture — two rules for the launcher')
      + '\n## Conduct rules\n\nRun each shell check as ONE simple command.\n',
    finding: 'rule carries no [BAR]/[PROCESS] tag: "Run each shell check as ONE simple command." '
      + '— untagged, the stricter judge reads it as bar and decides the contest (duels 258, 263)',
  },
  {
    name: 'duel-261 shape: chmod deliverable left on the side',
    brief: cleanBrief + '\nThe deliverable script must be installed via chmod 755.\n',
    finding: 'executable-bit requirement outside a controller-side execution list: "The '
      + 'deliverable script must be installed via chmod 755." — a lane that cannot set file '
      + 'modes converts the denial into a quality conviction (duels 258, 261)',
  },
  {
    name: 'chmod inside a controller-side execution section is clean',
    brief: cleanBrief
      + '\n## Controller-side execution\n\n- chmod 755 on the deliverable script after apply.\n',
  },
  {
    name: 'chmod declared controller-side inline is clean',
    brief: cleanBrief + '\nThe chmod 755 step is declared controller-side and runs after apply.\n',
  },
  {
    name: 'duel-417 shape: a backticked test-row name that carries the mode verb is not a requirement',
    brief: cleanBrief + '\nPlace the new row directly after the entry named `duel-261 shape: chmod deliverable left on the side`.\n',
  },
  {
    name: 'the finding text of the scan quoted in double quotes is not a requirement either',
    brief: cleanBrief + '\nThe lint message begins "executable-bit requirement" and the class name stays.\n',
  },
  {
    name: 'an unquoted file-mode requirement beside a quoted row name still flags',
    brief: cleanBrief + '\nRun chmod 755 on it; the row is `chmod deliverable`.\n',
    finding: 'executable-bit requirement outside a controller-side execution list: "Run chmod 755 on it; '
      + 'the row is `chmod deliverable`." — a lane that cannot set file modes converts the denial into a '
      + 'quality conviction (duels 258, 261)',
  },
  {
    name: 'dotted identifiers and extension names are not treated as repo paths',
    brief: cleanBrief + '\nThe pure API resolves against `opts.root`; the format is `.parquet`.\n',
  },
  {
    name: 'duel-416 shape: a backslash escape and relative module specifiers are not repo paths',
    brief: cleanBrief + '\nThe splitter reads `\\n`; the test imports `../src/cli.js` and `./duel.js`.\n',
  },
  {
    name: 'duel-283 shape: structural index pins without a declared base',
    brief: cleanBrief
      + '\nHeader rows: row 4 col0 `Date`, row 5 col3 `Total equity`. ASSERT all five.\n',
    finding: 'brief pins structural indices ("row 4") without declaring the base — 0-based vs '
      + '1-based split a side and a judge on the header location (duel 283)',
  },
  {
    name: 'index pins with a declared base are clean',
    brief: cleanBrief + '\nAll row/column indices below are 0-based.\n'
      + '\nHeader rows: row 4 col0 `Date`, row 5 col3 `Total equity`.\n',
  },
  {
    name: 'row counts are not index pins',
    brief: cleanBrief
      + '\nThe probe returned 887 rows; monthly first-of-month, 644 data rows through July.\n',
  },
  {
    name: 'row-spacing phrases are not index pins',
    brief: cleanBrief + '\n`annualizedPct` asserted on 14 weekly rows 13 apart.\n',
  },
  {
    name: 'duel-289 spelling: "header row index 3" is an index pin',
    brief: cleanBrief + '\nPinned: header row index 3 = c1 `Credit Card Balance`.\n',
    finding: 'brief pins structural indices ("row index 3") without declaring the base — '
      + '0-based vs 1-based split a side and a judge on the header location (duel 283)',
  },
  {
    name: 'index pin inside a code fence is skipped',
    brief: cleanBrief + '\n```\nrow 4 col0 Date\n```\n',
  },
  {
    name: 'duel-289 shape: negated null-family gate without its encoding family',
    brief: cleanBrief + '\n[BAR] A non-null maturity cell throws (fail closed).\n',
    finding: 'negated null-family gate without its encoding family: "[BAR] A non-null maturity '
      + 'cell throws (fail closed)." — "non-null X throws" makes each side pick its own absent '
      + 'set (JS null vs the file\'s "null" / "" / "*"); enumerate the encodings in the unit '
      + '(duel 289)',
  },
  {
    name: 'negated null-family gate inside a [BAR]-headed section is flagged',
    brief: cleanBrief + '\n## D2 [BAR] — parser\n\nA non-null maturity cell throws.\n',
    finding: 'negated null-family gate without its encoding family: "A non-null maturity cell '
      + 'throws." — "non-null X throws" makes each side pick its own absent set (JS null vs '
      + 'the file\'s "null" / "" / "*"); enumerate the encodings in the unit (duel 289)',
  },
  {
    name: 'negated null-family gate with its encodings enumerated is clean',
    brief: cleanBrief
      + '\n[BAR] A non-null maturity cell throws; absent encodings are null / "null" / "" / "*".\n',
  },
  {
    name: 'negated null-family gate outside any [BAR] context is not this finding',
    brief: cleanBrief + '\nA non-null maturity cell throws.\n',
  },
  {
    name: 'duel-391 M17: negated noun that is no data field is warning-class, not a block',
    brief: cleanBrief + '\n[BAR] A non-empty NOT RUN list fails the report.\n',
    finding: 'warn: negated null-family gate over "NOT RUN list" — no data-field noun follows '
      + 'the negation, so the encoding-family split (duel 289) may not apply; enumerate the '
      + 'absent encodings beside it if it does (duel 391 M17): "[BAR] A non-empty NOT RUN list '
      + 'fails the report."',
  },
  {
    name: 'duel-391 M17: a plural data-field noun after the negation still blocks',
    brief: cleanBrief + '\n[BAR] Non-empty maturity cells drop the row.\n',
    finding: 'negated null-family gate without its encoding family: "[BAR] Non-empty maturity '
      + 'cells drop the row." — "non-null X throws" makes each side pick its own absent '
      + 'set (JS null vs the file\'s "null" / "" / "*"); enumerate the encodings in the unit '
      + '(duel 289)',
  },
  {
    name: 'duel-414 shape: presence gate over a backticked field without its encoding family',
    brief: cleanBrief + '\n[BAR] Print `decided_by` when `decided_by` is present.\n',
    finding: 'presence gate without its encoding family: "[BAR] Print `decided_by` when '
      + '`decided_by` is present." — "when X is present" reads JS truthiness on one side and '
      + 'SQL NULL on the other; enumerate the absent encodings beside each gated field '
      + '(duel 414)',
  },
  {
    name: 'presence gate with its encodings enumerated is clean',
    brief: cleanBrief + '\n[BAR] Print `decided_by` when `decided_by` is present; absent is SQL NULL or \'\', never "null".\n',
  },
  {
    name: 'presence gate with no data field before it is warning-class, not a block',
    brief: cleanBrief + '\n[BAR] A parent whose directory is missing stands alone.\n',
    finding: 'warn: presence gate with no data field before it — the encoding-family split '
      + '(duel 414) may not apply; enumerate the absent encodings beside it if it does: '
      + '"[BAR] A parent whose directory is missing stands alone."',
  },
  {
    name: 'presence gate outside any [BAR] context is not this finding',
    brief: cleanBrief + '\nPrint `decided_by` when `decided_by` is present.\n',
  },
  {
    name: 'duel-391 M17: brief without the simple-command line is refused',
    brief: cleanBrief.replace('Run each shell check as ONE simple command.\n', ''),
    finding: 'brief lacks the simple-command line ("Run each shell check as ONE simple command '
      + '…") — lane B is gated by command shape, so every compound form it reaches for is a '
      + 'denied check its opponent runs for free (duels 202, 205, 208)',
  },
  {
    name: 'duel-391 M17: brief without the method-naming line is refused',
    brief: cleanBrief.replace('Every verification claim names the command you actually ran, verbatim.\n', ''),
    finding: 'brief lacks the method-naming line ("Every verification claim names the command '
      + 'you actually ran, verbatim …") — a method named but never invoked drew an integrity '
      + 'FAIL that had to be retracted (duel 208)',
  },
  {
    name: 'serena mandate: brief without the serena line is refused',
    brief: cleanBrief.replace('Navigate code with serena: open each source file with get_symbols_overview / find_symbol.\n', ''),
    finding: 'brief lacks the serena line ("Navigate code with serena: …") — without it a '
      + 'serena-equipped side never touches the server it started (3 of 425 lane-B sessions '
      + 'called it before the 2026-09-03 mandate)',
  },
  {
    name: 'fan-out parity (operator, 2026-09-03): brief without the fan-out line is refused',
    brief: cleanBrief.replace('You may fan out sub-agents on distinct subtasks; name the count in your report.\n', ''),
    finding: 'brief lacks the fan-out line ("You may fan out sub-agents on distinct subtasks …") '
      + '— without it the Claude side never fans out while codex does on its own '
      + '(implementation-build: lane B 0 of 113, codex 48 of 59 known, winning 29–14 there)',
  },
  {
    name: 'fan-out line wrapped across lines still counts',
    brief: cleanBrief.replace('You may fan out sub-agents on distinct subtasks;',
      'You may fan out\n  sub-agents on distinct subtasks;'),
  },
  {
    name: 'duel-391 M17: mutating brief (by title) without the IMPOSSIBLE-FIXTURE hatch warns',
    brief: cleanBrief.replace('# Duel 245 fixture', '# Duel 245 brief — implementation-build (mutating)'),
    finding: 'warn: mutating brief (per its title) carries no IMPOSSIBLE-FIXTURE hatch — without '
      + '"Fixture/test impossible as specified → STOP and report IMPOSSIBLE-FIXTURE" a side '
      + 'adapts production code to a broken fixture (duels 78, 196)',
  },
  {
    name: 'duel-391 M17: mutating brief with the hatch is clean',
    brief: cleanBrief.replace('# Duel 245 fixture', '# Duel 245 brief — implementation-build (mutating)')
      + '\nFixture/test impossible as specified → STOP and report IMPOSSIBLE-FIXTURE.\n',
  },
  {
    name: 'duel-391 M17: review brief (by title) without the severity rubric warns',
    brief: cleanBrief.replace('# Duel 245 fixture', '# Duel 245 brief — deep-review (union, read-only)'),
    finding: 'warn: review brief (per its title) carries no severity rubric — without the '
      + 'P0/P1/P2/P3 clauses each side self-grades by confidence, and a union ships unjudged '
      + '(duel 207)',
  },
  {
    name: 'duel-391 M17: review brief with the rubric is clean',
    brief: cleanBrief.replace('# Duel 245 fixture', '# Duel 245 brief — deep-review (union, read-only)')
      + '\nP0 — data loss or a corrupted ledger. P1 — wrong behavior reaches a supported path '
      + 'silently. P2 — a consumer surface prescribes the wrong path. P3 — invariant hygiene.\n',
  },
  {
    name: 'duel-391 M17: a non-review, non-mutating title asks for neither conditional line',
    brief: cleanBrief.replace('# Duel 245 fixture', '# Duel 245 brief — decision-brief: options doc'),
  },
  {
    name: 'direct (non-negated) predicate gate is clean',
    brief: cleanBrief + '\n[BAR] An empty ebp cell throws (fail closed).\n',
  },
  {
    name: 'duel-283/289 shape: clone-by-pointer without an acceptance surface',
    brief: cleanBrief + '\n[BAR] Clone the row shape the sibling rows use.\n',
    finding: 'clone-by-pointer without an acceptance surface: "[BAR] Clone the row shape the '
      + 'sibling rows use." — "clone the shape" hands the member list to each side\'s reading '
      + 'of the reference (duels 283 D4, 289 F1); enumerate the members ("complete list: …") '
      + 'or mark the unpinned part side-judgment with "disclose"',
  },
  {
    name: 'clone-by-pointer inside a [BAR]-headed section is flagged',
    brief: cleanBrief + '\n## D4 [BAR] — seeds\n\nClone the row shape the sibling rows use.\n',
    finding: 'clone-by-pointer without an acceptance surface: "Clone the row shape the sibling '
      + 'rows use." — "clone the shape" hands the member list to each side\'s reading '
      + 'of the reference (duels 283 D4, 289 F1); enumerate the members ("complete list: …") '
      + 'or mark the unpinned part side-judgment with "disclose"',
  },
  {
    name: 'clone directive with an enumerated member list is clean',
    brief: cleanBrief + '\n[BAR] Clone the row shape the sibling rows use (complete list: '
      + 'series_id, source, frequency, unit_mult, revision_policy).\n',
  },
  {
    name: 'clone directive with an explicit side-judgment delegation is clean',
    brief: cleanBrief + '\n[BAR] Clone the row shape the sibling rows use; unpinned members '
      + 'are side judgment — disclose your choices.\n',
  },
  {
    name: 'clone directive outside any [BAR] context is not this finding',
    brief: cleanBrief + '\nClone the row shape the sibling rows use.\n',
  },
  // Duel 391 M4: sectionText ended a section at a heading of ANY depth, so a `###` under a
  // `## … [BAR]` heading dropped every BAR-unit rule below it — the nested fixture linted
  // clean while the same text flattened tripped the null-family rule. One row per consumer.
  {
    name: 'duel-391 M4: a nested heading does not end the enclosing [BAR] section (null-family)',
    brief: cleanBrief
      + '\n## D2 [BAR] — parser\n\n### D2.1 — cells\n\nA non-null maturity cell throws.\n',
    finding: 'negated null-family gate without its encoding family: "A non-null maturity cell '
      + 'throws." — "non-null X throws" makes each side pick its own absent set (JS null vs '
      + 'the file\'s "null" / "" / "*"); enumerate the encodings in the unit (duel 289)',
  },
  {
    name: 'duel-391 M4: a nested heading does not end the enclosing [BAR] section (clone)',
    brief: cleanBrief
      + '\n## D4 [BAR] — seeds\n\n### D4.1 — rows\n\nClone the row shape the sibling rows use.\n',
    finding: 'clone-by-pointer without an acceptance surface: "Clone the row shape the sibling '
      + 'rows use." — "clone the shape" hands the member list to each side\'s reading '
      + 'of the reference (duels 283 D4, 289 F1); enumerate the members ("complete list: …") '
      + 'or mark the unpinned part side-judgment with "disclose"',
  },
  {
    name: 'duel-391 M4: a nested heading does not end the enclosing rules section',
    brief: cleanBrief
      + '\n## Conduct rules\n\n### Shell\n\nRun each shell check as ONE simple command.\n',
    finding: 'rule carries no [BAR]/[PROCESS] tag: "Run each shell check as ONE simple command." '
      + '— untagged, the stricter judge reads it as bar and decides the contest (duels 258, 263)',
  },
  {
    name: 'duel-391 M4: a nested heading does not end the controller-side execution list',
    brief: cleanBrief
      + '\n## Controller-side execution\n\n### After merge\n\nInstall the script via chmod 755.\n',
  },
  {
    name: 'duel-391 M4: a same-level heading still ends the [BAR] section',
    brief: cleanBrief
      + '\n## D2 [BAR] — parser\n\nParse cells.\n\n## Notes\n\nA non-null maturity cell throws.\n',
  },
  // Duel 391 M6: allowlist membership was substring-or-basename, so `hooks/hooks.json` passed
  // against an allowlist naming `config/hooks.json`, and `src/tool.ts` against one naming
  // `src/tool.ts.bak`. Entries are exact paths now; a bare basename admits only a unique file.
  {
    name: 'duel-391 M6: an allowlist entry sharing only the basename does not admit the file',
    brief: cleanBrief.replace('Create `src/tool.ts`.', 'Create `hooks/hooks.json`.')
      .replace('Allowlist: `src/tool.ts`.', 'Allowlist: `config/hooks.json`.'),
    finding: 'warn: brief quotes existing file `hooks/hooks.json` outside its own allowlist — '
      + "say whether it is in scope (duel 210's shape)",
  },
  {
    name: 'duel-391 M6: an allowlist entry that merely contains the path does not admit it',
    brief: cleanBrief.replace('Allowlist: `src/tool.ts`.', 'Allowlist: `src/tool.ts.bak`.'),
    finding: 'warn: brief quotes existing file `src/tool.ts` outside its own allowlist — '
      + "say whether it is in scope (duel 210's shape)",
  },
  {
    name: 'duel-391 M6: a bare basename in the allowlist admits nothing when it is ambiguous',
    brief: cleanBrief.replace('Create `src/tool.ts`.', 'Create `hooks/hooks.json`.')
      .replace('Allowlist: `src/tool.ts`.', 'Allowlist: `hooks.json`.'),
    finding: 'warn: brief quotes existing file `hooks/hooks.json` outside its own allowlist — '
      + "say whether it is in scope (duel 210's shape)",
  },
  {
    name: 'duel-391 M6: an unquoted exact path in the allowlist still admits the file',
    brief: cleanBrief.replace('Allowlist: `src/tool.ts`.', 'Allowlist: src/tool.ts, docs/reference.md.'),
  },
];

for (const row of CASES) {
  test(row.name, () => {
    const findings = lintBrief(row.brief, { root }).findings;
    if (row.finding) assert.ok(findings.includes(row.finding));
    else assert.deepEqual(findings, []);
  });
}

test('duel-391 M6: a bare basename in the allowlist admits the file when it is unique', () => {
  const brief = cleanBrief.replace('Allowlist: `src/tool.ts`.', 'Allowlist: `tool.ts`.');
  const findings = lintBrief(brief, { root }).findings;
  assert.deepEqual(findings.filter(f => f.includes('outside its own allowlist')), []);
  // the sloppy spelling itself still draws the did-you-mean warn — only the exact path is silent
  assert.ok(findings.some(f => f.includes('did you mean `src/tool.ts`')), findings.join('\n'));
});

test('sha256 digests the exact brief bytes', () => {
  const brief = cleanBrief + '\r\nExact trailing bytes: ☃\n';
  const expected = createHash('sha256').update(brief).digest('hex');
  assert.equal(lintBrief(brief, { root }).sha256, expected);
});

test('historical read-only brief marks an existing evidence path outside allowlist as likely fine', () => {
  // Copied verbatim from the opening of .review-scratch/duel163-brief.md. This is deliberately
  // a historical pre-linter shape: other structural findings may remain, but its declared read
  // scope must defuse the write-allowlist warning instead of pressuring an unnecessary edit.
  const historicalBrief = `# Duel 163 brief — deep review of v2.10.2..v2.10.5 fix wave

Repo: /home/user/model-routing (TypeScript showdown engine, SQLite matrix DB).
Scope: commits 27049cd, 722316c, 67adddd, e236450 (range 228373e..e236450).
Full diff pre-exported: \`.review-scratch/duel163-diff.patch\` (862 lines). Read source files directly for context.
`;
  const findings = lintBrief(historicalBrief, { root }).findings;
  assert.ok(findings.includes(
    'warn: brief quotes existing file `.review-scratch/duel163-diff.patch` outside its own '
      + 'allowlist — read scope declared — likely fine',
  ));
});
