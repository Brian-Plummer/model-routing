import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('package and plugin manifests ship the same version', () => {
  const readVersion = (path: string): string =>
    (JSON.parse(readFileSync(resolve(path), 'utf8')) as { version: string }).version;
  assert.equal(readVersion('package.json'), readVersion('.claude-plugin/plugin.json'));
});
