import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { stagePackagedProcessHost } from '../../../config/scripts/desktop-distribution/runtime-verification/packaged-process-host-fixture.mjs'

const require = createRequire(import.meta.url)
const probePath = require.resolve('./packaged-node-pty-capability-probe.cjs')
const { isOneShotMode, packagedProcessHostPath } = require(probePath)

// The private copy packaged main emitted before the public package existed.
async function stageLegacyRunProcess(resourcesDir) {
  const legacyDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'shared', 'child-process')
  await mkdir(legacyDir, { recursive: true })
  const legacy = join(legacyDir, 'run-process.js')
  await writeFile(legacy, "exports.spawnProcess = () => 'legacy spawnProcess'\n")
  return legacy
}

describe('packaged node-pty launcher-surviving grandchild', () => {
  it('flushes one-shot evidence and exits despite a referenced handle', async () => {
    expect(isOneShotMode('--exercise')).toBe(true)
    expect(isOneShotMode('--exit-contract-fixture')).toBe(true)
    expect(isOneShotMode('--pty-shell')).toBe(false)

    const result = await runProcess({
      program: process.execPath,
      args: [probePath, '--exit-contract-fixture'],
      timeoutMs: 5_000
    })

    expect(result).toMatchObject({ code: 0, timedOut: false })
    expect(result.stdout).toBe('ORCA_ONE_SHOT_EVIDENCE=flushed\n')
    expect(result.stderr).toBe('')
  })

  it('loads spawnProcess from the private out/ copy of a package that predates the public one', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-pty-capability-legacy-'))
    try {
      const legacy = await stageLegacyRunProcess(resourcesDir)
      const entry = packagedProcessHostPath(resourcesDir)

      expect(realpathSync(require.resolve(entry))).toBe(realpathSync(legacy))
      expect(require(entry).spawnProcess()).toBe('legacy spawnProcess')
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('fails on a broken public package rather than loading the legacy copy', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-pty-capability-broken-'))
    try {
      const legacy = await stageLegacyRunProcess(resourcesDir)
      const packageDir = await stagePackagedProcessHost(resourcesDir)
      await rm(join(packageDir, 'dist', 'run-process.js'))

      expect(packagedProcessHostPath(resourcesDir)).toBe(packageDir)
      expect(require(legacy).spawnProcess()).toBe('legacy spawnProcess')
      expect(() => require(packagedProcessHostPath(resourcesDir))).toThrow()

      await rm(join(packageDir, 'package.json'))
      expect(() => packagedProcessHostPath(resourcesDir)).toThrow(
        /packaged @orca\/process-host has no package\.json/
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })
})
