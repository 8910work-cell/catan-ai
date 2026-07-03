// Network-free validation of the Claude Code skills in .claude/skills/.
// Mirrors the authoring rules used in trading-ai-reality-check/tests/test_skills.py:
// legal skill name, third-person description within the 1024-char cap,
// frontmatter name matching the directory, and a <=500-line body.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = '.claude/skills';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BAD_DESCRIPTION_START = /^(i|you|we)\b/i;
const EXPECTED = ['commit', 'debugging', 'handoff', 'oss-contribution',
                  'summarize-changes', 'tdd-cycle'];

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };

const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();

for (const name of EXPECTED) {
  if (!dirs.includes(name)) fail(`missing expected skill: ${name}`);
}

for (const name of dirs) {
  const path = join(SKILLS_DIR, name, 'SKILL.md');
  if (!NAME_RE.test(name)) fail(`${name}: illegal skill name`);

  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[0] !== '---') { fail(`${path}: must start with '---'`); continue; }
  const end = lines.indexOf('---', 1);
  if (end === -1) { fail(`${path}: unterminated frontmatter`); continue; }

  const fm = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || /^[\s-]/.test(line)) continue;
    const i = line.indexOf(':');
    if (i === -1) { fail(`${path}: bad frontmatter line: ${line}`); continue; }
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  const desc = fm.description ?? '';
  if (!desc) fail(`${path}: missing description`);
  if (desc.length > 1024) fail(`${path}: description over 1024 chars`);
  if (BAD_DESCRIPTION_START.test(desc)) fail(`${path}: description must be third person`);
  if (fm.name && fm.name !== name) fail(`${path}: frontmatter name must match directory`);
  if (lines.length - end - 1 > 500) fail(`${path}: body over 500 lines`);
}

if (failures > 0) {
  console.error(`${failures} skill validation failure(s)`);
  process.exit(1);
}
console.log(`skill validation OK: ${dirs.length} skills checked`);
