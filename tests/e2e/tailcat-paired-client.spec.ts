import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@stablyai/playwright-test'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { decodePairingOffer } from '../../src/shared/pairing'
import { resolveTailcatBinary } from '../../src/main/tunnel/tailcat-binary'

// Why: runs only where the tailcat CLI is installed; it bootstraps through Tailcat's public relay.
test.skip(resolveTailcatBinary() === null, 'tailcat CLI not installed')
// Why: the process census below uses pgrep, which Windows does not have.
test.skip(process.platform === 'win32', 'process census uses pgrep')

function tailcatProcesses(): string[] {
  try {
    return execFileSync('pgrep', ['-fl', 'tailcat'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => /tailcat.* (serve|socks)/.test(line))
  } catch {
    return []
  }
}

test('a paired desktop client reaches a --tailcat serve host only through the tunnel', async () => {
  const testInfo = test.info()
  test.setTimeout(300_000)
  const before = tailcatProcesses()
  // Why 192.0.2.1: TEST-NET is unroutable, so a direct dial to the advertised endpoint cannot succeed.
  // Why pinned: a tunnel serve refuses `--port 0`, since every link embeds the port.
  const host = await launchHeadlessPairedRuntimeHost({
    pairingAddress: '192.0.2.1',
    pinnedServePort: true,
    extraServeArgs: ['--serve-tailcat']
  })
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null
  let userDataDir: string | null = null
  try {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-tailcat-client-'))
    writeFileSync(
      path.join(userDataDir, 'orca-data.json'),
      `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
    )
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
    void _unused
    const isolation = createElectronHomeIsolation({
      inheritedEnv: cleanEnv,
      launchEnv: {},
      extraEnv: {},
      userDataDir
    })
    app = await electron.launch({
      args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
      env: { ...isolation.env, NODE_ENV: 'development', ORCA_E2E_HEADLESS: '1' }
    })
    forwardElectronProcessLogs(app, testInfo)
    const offer = decodePairingOffer(host.offer.pairingUrl)
    expect(offer.endpoint).toBe(`ws://192.0.2.1:${new URL(offer.endpoint).port}`)
    expect(offer.tunnel).toMatchObject({ v: 1, kind: 'tailcat' })
    expect(offer.tunnel?.token.startsWith('tc')).toBe(true)
    expect(tailcatProcesses().filter((line) => / serve /.test(line)).length).toBeGreaterThan(
      before.filter((line) => / serve /.test(line)).length
    )

    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      {
        timeout: 60_000
      }
    )
    // Why: the production add path dials the host to verify it before saving; that dial must use the tunnel.
    const verified = await page.evaluate(
      (pairingCode) =>
        window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
          name: 'Tailcat host',
          pairingCode
        }),
      host.offer.pairingUrl
    )
    console.log(`[tailcat-e2e] verifyAndAdd: ${JSON.stringify(verified).slice(0, 300)}`)
    expect(verified.ok).toBe(true)
    if (!verified.ok) {
      return
    }
    const environment = verified.environment
    console.log(
      `[tailcat-e2e] saved environment: dependency=${environment.connectionDependency} tunnel=${JSON.stringify(environment.endpoints[0]?.tunnel)}`
    )
    expect(environment.connectionDependency).toBe('tailcat')
    expect(environment.endpoints[0]?.tunnel?.kind).toBe('tailcat')

    const startedAt = Date.now()
    const status = await page.evaluate(
      (selector) => window.api.runtimeEnvironments.getStatus({ selector, timeoutMs: 90_000 }),
      environment.id
    )
    console.log(
      `[tailcat-e2e] first status after ${Date.now() - startedAt}ms: ${JSON.stringify(status).slice(0, 600)}`
    )
    expect(status.ok).toBe(true)

    // Why: the client must have spawned its own `tailcat socks` proxy to get here.
    expect(tailcatProcesses().filter((line) => / socks /.test(line)).length).toBeGreaterThan(
      before.filter((line) => / socks /.test(line)).length
    )

    const secondAt = Date.now()
    const again = await page.evaluate(
      (selector) => window.api.runtimeEnvironments.getStatus({ selector, timeoutMs: 30_000 }),
      environment.id
    )
    console.log(`[tailcat-e2e] second status after ${Date.now() - secondAt}ms ok=${again.ok}`)
    expect(again.ok).toBe(true)
  } finally {
    // Why: the host owns a tailcat child, so it must be disposed even when the client never launched.
    if (app) {
      await closeElectronAppForE2E(app)
    }
    if (userDataDir) {
      await cleanupE2EDaemons(userDataDir)
      rmSync(userDataDir, { recursive: true, force: true })
    }
    await host.dispose()
  }
  // Why: quitting either side must take its tailcat child with it.
  await expect.poll(() => tailcatProcesses().length, { timeout: 15_000 }).toBe(before.length)
})
