#!/usr/bin/env node

import fs from 'node:fs';

const source = fs.readFileSync(new URL('./kimi', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('./install.mjs', import.meta.url), 'utf8');
const expectations = [
  ['local Anthropic gateway', /export ANTHROPIC_BASE_URL="\$router_url\/coding\/"/],
  ['all Claude model aliases', /export ANTHROPIC_DEFAULT_OPUS_MODEL="\$kimi_model"[\s\S]*export ANTHROPIC_DEFAULT_HAIKU_MODEL="\$kimi_model"/],
  ['automatic compact window', /export CLAUDE_CODE_AUTO_COMPACT_WINDOW="\$kimi_context_tokens"/],
  ['maximum effort default', /export CLAUDE_CODE_EFFORT_LEVEL="\$\{CLAUDE_CODE_EFFORT_LEVEL:-max\}"/],
  ['tool search compatibility default', /export ENABLE_TOOL_SEARCH="\$\{ENABLE_TOOL_SEARCH:-false\}"/],
  ['management header stays out of process arguments', /command curl -H @"\$management_header_file"/],
];

let failures = 0;
console.log('running launcher contract tests...');
for (const [name, pattern] of expectations) {
  const passed = pattern.test(source);
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`);
  if (!passed) failures += 1;
}
const installerPassed = /randomBytes\(32\)/.test(installer) &&
  /KIMI_MANAGEMENT_TOKEN_FILE/.test(installer) &&
  /chmodSync\(managementHeaderFile, 0o600\)/.test(installer);
console.log(`  ${installerPassed ? 'PASS' : 'FAIL'}  installer creates a permission-restricted management credential`);
if (!installerPassed) failures += 1;

if (failures > 0) {
  console.error(`${failures} launcher contract test(s) failed`);
  process.exit(1);
}
console.log('ALL LAUNCHER TESTS PASSED');
