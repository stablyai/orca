import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRuntimeMetadataPath } from '../../src/shared/runtime-bootstrap'
import { expect, test } from './helpers/orca-app'
import { launchOwnedBrowserForE2E } from './helpers/orca-restart'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'

test.use({ seedTestRepo: false })

for (const early of [false, true]) {
  test(`hidden browser exits after owner loss ${early ? 'during startup' : 'after readiness'}`, async () => {
    const profile = mkdtempSync(
      join(process.platform === 'win32' ? tmpdir() : '/tmp', 'orca-owner-')
    )
    const child = launchOwnedBrowserForE2E(profile)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384)
    })
    child.stdout?.resume()
    try {
      if (!early) {
        await expect
          .poll(() => existsSync(getRuntimeMetadataPath(profile)), {
            message: 'Browser should become ready while its owner is connected',
            timeout: 30_000
          })
          .toBe(true)
        expect(child.exitCode, stderr).toBeNull()
      }
      child.disconnect()
      await expect
        .poll(() => child.exitCode, {
          message: 'Owner loss should gracefully stop the real browser process',
          timeout: 15_000
        })
        .toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await expect
          .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 5_000 })
          .toBe(true)
      }
      await cleanupE2EDaemons(profile)
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
}
