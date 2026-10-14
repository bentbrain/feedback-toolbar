import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseRunner } from '../src/cli/runner-process.js';

for (const mode of ['cancel', 'normal-exit']) {
  void test(
    `runner ${mode} stops tool subprocesses before delayed workspace writes`,
    { timeout: 10_000 },
    async (t) => {
      if (process.platform === 'win32') {
        t.skip('POSIX runner only.');
        return;
      }
      const directory = await mkdtemp(join(tmpdir(), 'feedback-process-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const result = join(directory, 'late-result.txt');
      const parent = `
        const {spawn} = require('node:child_process');
        const tool = "const fs=require('node:fs'); process.on('SIGTERM',()=>{}); console.log('ready'); setTimeout(()=>fs.writeFileSync('late-result.txt','cancelled-write'),2000); setInterval(()=>{},1000);";
        const child = spawn(process.execPath, ['-e', tool], {
          detached: process.argv[1] === 'cancel', stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout.once('data', () => {
          console.log('ready');
          if (process.argv[1] === 'normal-exit') setTimeout(() => process.exit(0), 200);
        });
        process.on('SIGTERM', () => process.exit(0));
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['-e', parent, mode], {
        cwd: directory,
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const supervised = superviseRunner(child);
      t.after(() => supervised.terminate());
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', () => {
          resolve();
        });
      });
      if (mode === 'normal-exit') assert.equal(await supervised.exited, 0);
      // A separate user process must remain alive while the owned groups are stopped.
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      });
      t.after(() => {
        unrelated.kill('SIGTERM');
      });
      await supervised.terminate();
      await supervised.exited;
      assert.ok(unrelated.pid);
      assert.doesNotThrow(() => process.kill(unrelated.pid ?? 0, 0));
      await delay(2200);
      await assert.rejects(stat(result), { code: 'ENOENT' });
    },
  );
}
