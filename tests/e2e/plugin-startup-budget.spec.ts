/**
 * App-level complement to the deterministic subsystem P95 test: alternate
 * real Electron launches with zero and twenty approved plugins, then compare
 * startup milestones and prove no worker entry executed before a trigger.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type TestInfo } from '@stablyai/playwright-test'
import { fingerprintPluginConsent } from '../../src/shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../src/shared/plugins/plugin-manifest'
import { createRestartSession } from './helpers/orca-restart'

const PLUGIN_COUNT = 20
const SAMPLE_COUNT = 3

type StartupSample = {
  readyToShowMs: number
  pluginDurationMs: number
  installedPlugins: number
}

function updateProfile(userDataDir: string, pluginConsents: Record<string, string>): void {
  const profilePath = join(userDataDir, 'orca-data.json')
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
    settings?: Record<string, unknown>
  }
  profile.settings = {
    ...profile.settings,
    pluginSystemEnabled: true,
    pluginConsents,
    disabledPlugins: [],
    devPluginPaths: []
  }
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
}

function seedPlugins(userDataDir: string, count: number): string[] {
  const pluginsDir = join(userDataDir, 'plugins')
  rmSync(pluginsDir, { recursive: true, force: true })
  mkdirSync(pluginsDir, { recursive: true })
  const pluginConsents: Record<string, string> = {}
  const markerPaths: string[] = []
  for (let index = 0; index < count; index += 1) {
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: `startup-${index}`,
      publisher: 'budget',
      name: `Startup ${index}`,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: { panels: [], commands: [], events: [] },
      capabilities: []
    })
    const pluginKey = `${manifest.publisher}.${manifest.id}`
    const contentHash = (index + 1).toString(16).padStart(64, '0')
    const versionDir = join(pluginsDir, pluginKey, contentHash)
    const markerPath = join(userDataDir, `plugin-startup-marker-${index}`)
    mkdirSync(versionDir, { recursive: true })
    writeFileSync(join(pluginsDir, pluginKey, 'current'), contentHash)
    writeFileSync(join(versionDir, 'orca-plugin.json'), JSON.stringify(manifest))
    writeFileSync(
      join(versionDir, 'main.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'executed')`
    )
    pluginConsents[pluginKey] = fingerprintPluginConsent(manifest)
    markerPaths.push(markerPath)
  }
  updateProfile(userDataDir, pluginConsents)
  return markerPaths
}

function parseMetric(output: string, event: string, key: string): number | null {
  const line = output.split('\n').find((candidate) => candidate.startsWith(`[startup] ${event} `))
  const value = line?.match(new RegExp(`(?:^| )${key}=([0-9.]+)(?: |$)`))?.[1]
  return value === undefined ? null : Number(value)
}

async function launchSample(
  session: ReturnType<typeof createRestartSession>,
  expectedPlugins: number,
  testInfo: TestInfo
): Promise<StartupSample> {
  let output = ''
  const attachLogs = (app: ElectronApplication): void => {
    app.process().stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
  }
  const launched = await session.launch(attachLogs)
  try {
    await expect
      .poll(
        () => ({
          ready: parseMetric(output, 'ready-to-show', 't'),
          duration: parseMetric(output, 'plugin-system-initialized', 'durationMs'),
          count: parseMetric(output, 'plugin-system-initialized', 'installedPlugins')
        }),
        { timeout: 30_000 }
      )
      .toMatchObject({
        ready: expect.any(Number),
        duration: expect.any(Number),
        count: expectedPlugins
      })
    await testInfo.attach(`plugin-startup-${expectedPlugins}-${Date.now()}.log`, {
      body: Buffer.from(output),
      contentType: 'text/plain'
    })
    return {
      readyToShowMs: parseMetric(output, 'ready-to-show', 't')!,
      pluginDurationMs: parseMetric(output, 'plugin-system-initialized', 'durationMs')!,
      installedPlugins: parseMetric(output, 'plugin-system-initialized', 'installedPlugins')!
    }
  } finally {
    await session.close(launched.app)
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('keeps real Electron launch stable with 20 approved inert plugins', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const session = createRestartSession(testInfo, {
    extraEnv: { ORCA_STARTUP_DIAGNOSTICS: '1' }
  })
  const baseline: StartupSample[] = []
  const populated: StartupSample[] = []
  let markerPaths: string[] = []
  try {
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      seedPlugins(session.userDataDir, 0)
      baseline.push(await launchSample(session, 0, testInfo))
      markerPaths = seedPlugins(session.userDataDir, PLUGIN_COUNT)
      populated.push(await launchSample(session, PLUGIN_COUNT, testInfo))
    }

    // The isolated 20-sample unit gate owns the ≤50 ms P95. This app-level
    // complement measures the user-visible launch delta because background
    // discovery completion overlaps unrelated main-process startup work.
    expect(populated.every((sample) => Number.isFinite(sample.pluginDurationMs))).toBe(true)
    expect(median(populated.map((sample) => sample.readyToShowMs))).toBeLessThanOrEqual(
      median(baseline.map((sample) => sample.readyToShowMs)) + 50
    )
    expect(markerPaths.every((markerPath) => !existsSync(markerPath))).toBe(true)
  } finally {
    await session.dispose()
  }
})
