import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrivateJson } from './private-file.ts';

test('private JSON writes atomically; rejects non-file destinations and cleans failed serialization', () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-private-file-'));
  try {
    const path = join(home, 'private.json');
    writePrivateJson(path, { value: 1 });
    writePrivateJson(path, { value: 2 });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 2 });
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    mkdirSync(join(home, 'directory.json'));
    assert.throws(() => writePrivateJson(join(home, 'directory.json'), {}), /Unsafe/);
    assert.throws(() => writePrivateJson(join(home, 'missing', 'private.json'), {}));
    assert.throws(() => writePrivateJson(path, { fail: BigInt(1) }));
    assert.equal(readdirSync(home).filter((name) => name.endsWith('.tmp')).length, 0);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 2 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
