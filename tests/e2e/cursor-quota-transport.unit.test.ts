import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { runProcess } from '../../src/shared/child-process/run-process'
import { resolveElectronProbeLaunch } from '../../src/main/browser/electron-probe-display-launch'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'

const outcomeSchema = z.object({
  arm: z.string(),
  status: z.string(),
  used: z.number().optional(),
  failureKind: z.string().optional()
})
const wireSchema = z.object({
  electron: z.string(),
  chrome: z.string(),
  receipts: z.array(
    z.object({ arm: z.string(), path: z.string(), account: z.string(), headerAccount: z.string() })
  ),
  outcomes: z.array(outcomeSchema),
  jarUnchanged: z.array(z.boolean()),
  targetHits: z.number()
})

it('keeps Cursor account credentials independent of the native Electron cookie jar', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-cursor-wire-'))
  try {
    const binary: unknown = createRequire(import.meta.url)('electron')
    if (typeof binary !== 'string') {
      throw new Error('Electron executable unavailable')
    }
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        emptyOutDir: false,
        target: 'node24',
        outDir: root,
        lib: {
          entry: join(process.cwd(), 'tests/e2e/helpers/cursor-quota-wire.fixture.ts'),
          formats: ['cjs'],
          fileName: () => 'fixture.cjs'
        },
        rollupOptions: { external: ['electron', /^node:/] }
      }
    })
    const resultPath = join(root, 'result.json')
    const isolation = createElectronHomeIsolation({
      inheritedEnv: process.env,
      launchEnv: {},
      userDataDir: join(root, 'profile'),
      extraEnv: {
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_DISABLE_CODEX_TRUST_RPC: '1',
        ORCA_CURSOR_WIRE_RESULT: resultPath
      }
    })
    delete isolation.env.ELECTRON_RUN_AS_NODE
    const launch = resolveElectronProbeLaunch({
      electronBinary: binary,
      electronArgs: [join(root, 'fixture.cjs')],
      platform: process.platform,
      display: isolation.env.DISPLAY
    })
    const result = await runProcess({
      program: launch.executable,
      args: launch.args,
      env: isolation.env,
      timeoutMs: 60_000
    })
    const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
    const diagnostic = JSON.stringify({
      platform: process.platform,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      fixtureResult,
      stdout: result.stdout,
      stderr: result.stderr
    })
    expect(result.code, diagnostic).toBe(0)
    expect(result.timedOut, diagnostic).toBe(false)
    const wire = wireSchema.parse(JSON.parse(readFileSync(resultPath, 'utf8')))
    for (const protocol of ['http', 'https']) {
      for (const [name, used] of [
        ['empty-A', 25],
        ['jar-A-A', 25],
        ['jar-A-B', 75],
        ['jar-B-A', 25],
        ['old-A-fresh-A', 25],
        ['parallel-A', 25],
        ['parallel-B', 75]
      ] as const) {
        expect(wire.outcomes.find(({ arm }) => arm === `${protocol}-${name}`)).toMatchObject({
          status: 'ok',
          used
        })
      }
      for (const [name, failureKind] of [
        ['http401', 'stale-token'],
        ['http403', 'server'],
        ['http429', 'rate-limited'],
        ['http500', 'server'],
        ['parse', 'parse'],
        ['disconnect', 'network'],
        ['redirect302', 'network'],
        ['redirect307', 'network'],
        ['expired', 'stale-token'],
        ['aborted', 'network']
      ] as const) {
        expect(wire.outcomes.find(({ arm }) => arm === `${protocol}-${name}`)).toMatchObject({
          status: 'error',
          failureKind
        })
      }
      expect(wire.outcomes.find(({ arm }) => arm === `${protocol}-legacy`)).toMatchObject({
        status: 'ok',
        used: 25
      })
      expect(wire.receipts.filter(({ arm }) => arm === `${protocol}-legacy`)).toMatchObject([
        { path: '/api/usage-summary', account: 'A' },
        { path: '/api/usage?user=auth0%7Cfake_A', account: 'A' }
      ])
      expect(
        wire.receipts.filter(
          ({ arm }) => arm === `${protocol}-expired` || arm === `${protocol}-aborted`
        )
      ).toEqual([])
    }
    expect(wire.jarUnchanged).toEqual(Array.from({ length: 10 }, () => true))
    expect(wire.targetHits).toBe(0)
    expect(wire.receipts.every(({ headerAccount }) => headerAccount === 'none')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 90_000)
