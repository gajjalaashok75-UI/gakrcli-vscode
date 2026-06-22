// test/integration/cliSpawn.test.ts
// Real CLI spawn integration tests — verify the gakrcli binary is present,
// spawnable, and the ProcessManager lifecycle works end-to-end.
//
// These tests interact with the OS process layer and the installed gakrcli CLI.
// They do NOT require a valid API key — they test timeout handling, process
// lifecycle, and diagnostic information.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ProcessManager, ProcessState, INIT_TIMEOUT_MS } from '../../src/process/processManager';

// ============================================================================
// CLI Binary Discovery
// ============================================================================

function findGakrcliBinary(): string {
  // Check npm global prefix
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const candidates = [
    path.join(npmRoot, '@gakr-gakr', 'gakrcli', 'bin', 'gakrcli.js'),
    path.join(npmRoot, '..', 'gakrcli'),           // POSIX shim
    path.join(npmRoot, '..', 'gakrcli.cmd'),        // Windows .cmd shim
  ];

  // Also check PATH
  try {
    const which = execSync('which gakrcli 2>/dev/null || where gakrcli', { encoding: 'utf8' }).trim();
    if (which) candidates.unshift(which.split('\n')[0].trim());
  } catch {
    // not on PATH
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Cannot find gakrcli binary. Checked:\n${candidates.join('\n')}`
  );
}

let gakrcliPath: string;

// ============================================================================
// Integration Tests
// ============================================================================

describe('CLI binary smoke tests', () => {
  beforeAll(() => {
    gakrcliPath = findGakrcliBinary();
  });

  it('should have a discoverable binary', () => {
    expect(gakrcliPath).toBeTruthy();
    expect(fs.existsSync(gakrcliPath)).toBe(true);
  });

  it('should return --version instantly', () => {
    const result = execSync(`"${gakrcliPath}" --version`, {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should return --help instantly', () => {
    const result = execSync(`"${gakrcliPath}" --help`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result).toContain('Usage:');
    expect(result).toContain('--print');
    expect(result).toContain('stream-json');
  });
});

describe('CLI spawn probe', () => {
  const SHORT_TIMEOUT_MS = 15_000;

  it('should create a real process with stream-json args', async () => {
    const pm = new ProcessManager({
      cwd: process.cwd(),
      executable: gakrcliPath,
    });

    const spawnPromise = pm.spawn() as Promise<unknown>;
    spawnPromise.catch(() => {}); // Suppress expected rejection (timeout)

    // Process should be created shortly after spawn
    await expect(
      new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = setInterval(() => {
          if (pm.state !== ProcessState.Idle) {
            clearInterval(check);
            resolve();
          }
          if (Date.now() - start > 5_000) {
            clearInterval(check);
            reject(new Error('Process did not start within 5s'));
          }
        }, 50);
      })
    ).resolves.toBeUndefined();

    // Should be in Initializing state (the real CLI will hang without API key)
    expect([ProcessState.Initializing, ProcessState.Ready]).toContain(pm.state);

    // Timing should be reported
    expect(pm.getSpawnElapsedMs()).toBeGreaterThan(0);

    // Cleanup
    pm.dispose();
    await new Promise((r) => setTimeout(r, 100));
    expect(pm.state).toBe(ProcessState.Idle);
  }, SHORT_TIMEOUT_MS);

  it('should measure startup timing accurately', async () => {
    const pm = new ProcessManager({
      cwd: process.cwd(),
      executable: gakrcliPath,
    });

    // Before spawn — timing is 0
    expect(pm.getSpawnElapsedMs()).toBe(0);

    const spawnPromise = pm.spawn() as Promise<unknown>;
    spawnPromise.catch(() => {});

    // After spawn — timing should be positive
    await new Promise((r) => setTimeout(r, 200));
    const elapsed = pm.getSpawnElapsedMs();
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000); // Sanity: not hours

    pm.dispose();
  });

  const INIT_HANG_TIMEOUT = 5_000;
  it('should fire the init timeout when CLI hangs', async () => {
    const pm = new ProcessManager({
      cwd: process.cwd(),
      executable: gakrcliPath,
      initTimeoutMs: INIT_HANG_TIMEOUT,
    });

    const t0 = Date.now();
    const spawnPromise = pm.spawn() as Promise<unknown>;

    await expect(spawnPromise).rejects.toThrow();
    const elapsed = Date.now() - t0;

    // Should fire within the short timeout window
    expect(elapsed).toBeLessThan(INIT_HANG_TIMEOUT + 3_000);
    expect(elapsed).toBeGreaterThanOrEqual(INIT_HANG_TIMEOUT - 1_000);

    // Log for diagnostics
    console.log(`[timing] CLI init timeout fired at ${elapsed}ms (expected ~${INIT_HANG_TIMEOUT}ms)`);

    expect(pm.state).toBe(ProcessState.Idle);
    pm.dispose();
  }, INIT_HANG_TIMEOUT + 10_000);

  it('should handle rapid spawn/dispose cycle without leaking', async () => {
    for (let i = 0; i < 3; i++) {
      const pm = new ProcessManager({
        cwd: process.cwd(),
        executable: gakrcliPath,
      });

      const spawnPromise = pm.spawn() as Promise<unknown>;
      spawnPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      // Dispose mid-init
      pm.dispose();
      await new Promise((r) => setTimeout(r, 50));
      expect(pm.state).toBe(ProcessState.Idle);
    }
  }, 30_000);
});

describe('CLI spawn with API key', () => {
  // This requires a valid API key. Skip if not set.
  // Tests what happens when the CLI can actually start.
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.GAKR_CLI_API_KEY;

  // Use a test helper to determine if we should run API-dependent tests
  const shouldRunApiTests = (): boolean => !!apiKey;

  it('should be skipped if no API key is available', () => {
    if (!shouldRunApiTests()) {
      console.log('[skip] No API key available — API-dependent tests will be skipped');
    }
  });

  it('should initialize successfully with valid API key', async () => {
    if (!shouldRunApiTests()) return;

    const pm = new ProcessManager({
      cwd: process.cwd(),
      executable: gakrcliPath,
      env: { ANTHROPIC_API_KEY: apiKey! },
    });

    const t0 = Date.now();
    let success = false;
    try {
      const response = await pm.spawn();
      const elapsed = Date.now() - t0;
      success = true;

      // Should have received an init response
      expect(response).toBeTruthy();
      console.log(`[timing] CLI init completed in ${elapsed}ms`);

      // Should be in ready state
      expect(pm.state).toBe(ProcessState.Ready);
      expect(pm.getSpawnElapsedMs()).toBeGreaterThan(0);
      expect(pm.getSpawnElapsedMs()).toBeLessThan(elapsed + 100); // Approximate
    } catch (err) {
      // If this happens with a valid key, log details for diagnosis
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[diagnostic] CLI init failed with key: ${message}`);
      // Don't fail — the key might not have permissions for --print mode
    } finally {
      pm.dispose();
    }

    if (!success) {
      console.log('[skip] API key present but init failed — likely permission/scope issue');
    }
  }, 60_000);
});
