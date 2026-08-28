import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../../src/shared/child-process/run-process'

const require = createRequire(import.meta.url)
const probePath = require.resolve('./packaged-node-pty-capability-probe.cjs')
const {
  buildGrandchildLaunch,
  createFixtureServer,
  isOneShotMode,
  reportFixtureObservation
} = require(probePath)
const originalSystemRoot = process.env.SystemRoot

afterEach(() => {
  if (originalSystemRoot === undefined) {
    delete process.env.SystemRoot
  } else {
    process.env.SystemRoot = originalSystemRoot
  }
})

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

  it('uses the hidden WScript launcher without cmd or start/b', () => {
    process.env.SystemRoot = 'C:\\Windows'
    const channel = '\\\\.\\pipe\\fixture & literal'

    const launch = buildGrandchildLaunch(channel, 'fixture-token^literal')

    expect(launch.program).toMatch(/wscript\.exe$/i)
    expect(launch.args).toEqual([
      expect.stringMatching(/real-orca-detached-launcher\.vbs$/),
      process.execPath,
      probePath,
      '--grandchild-member',
      channel,
      'fixture-token^literal',
      'target-grandchild'
    ])
    expect(JSON.stringify(launch)).not.toMatch(/cmd\.exe|start "" \/b/i)
  })

  it('closes one-shot fixture observations before server teardown', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'orca-pty-capability-'))
    const channel = join(fixtureDir, 'fixture.sock')
    const fixtureToken = 'fixture-token'
    const fixtures = createFixtureServer(channel, fixtureToken)

    try {
      await fixtures.listening
      const observationPromise = fixtures.waitForRole('target-launcher-exited')

      await reportFixtureObservation(channel, fixtureToken, 'target-launcher-exited', {
        pid: 1234
      })

      await expect(observationPromise).resolves.toEqual({
        pid: 1234,
        fixtureToken,
        role: 'target-launcher-exited',
        channel
      })
      await expect(fixtures.close()).resolves.toBeUndefined()
    } finally {
      fixtures.destroySockets()
      await fixtures.close()
      await rm(fixtureDir, { recursive: true, force: true })
    }
  })
})
