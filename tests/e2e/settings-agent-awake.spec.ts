import { randomUUID } from 'node:crypto'
import { runProcess } from '@orca/process-host'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'

type AwakeProbeSnapshot = {
  starts: { type: string; id: number }[]
  stops: { id: number }[]
  activeIds: number[]
}

async function setKeepAwake(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const nextSettings = await window.api.settings.set({
      keepComputerAwakeWhileAgentsRun: enabled
    })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  }, enabled)
}

async function installPowerSaveBlockerProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ powerSaveBlocker }) => {
    const root = globalThis as typeof globalThis & {
      __orcaAwakePowerProbe?: {
        starts: { type: string; id: number }[]
        stops: { id: number }[]
        originalStart: typeof powerSaveBlocker.start
        originalStop: typeof powerSaveBlocker.stop
      }
    }
    if (root.__orcaAwakePowerProbe) {
      root.__orcaAwakePowerProbe.starts = []
      root.__orcaAwakePowerProbe.stops = []
      return
    }

    const originalStart = powerSaveBlocker.start.bind(powerSaveBlocker)
    const originalStop = powerSaveBlocker.stop.bind(powerSaveBlocker)
    root.__orcaAwakePowerProbe = {
      starts: [],
      stops: [],
      originalStart,
      originalStop
    }

    powerSaveBlocker.start = ((type) => {
      const id = originalStart(type)
      root.__orcaAwakePowerProbe?.starts.push({ type, id })
      return id
    }) as typeof powerSaveBlocker.start

    powerSaveBlocker.stop = ((id) => {
      root.__orcaAwakePowerProbe?.stops.push({ id })
      originalStop(id)
    }) as typeof powerSaveBlocker.stop
  })
}

async function readPowerSaveBlockerProbe(
  electronApp: ElectronApplication
): Promise<AwakeProbeSnapshot> {
  return electronApp.evaluate(({ powerSaveBlocker }) => {
    const probe = (
      globalThis as typeof globalThis & {
        __orcaAwakePowerProbe?: {
          starts: { type: string; id: number }[]
          stops: { id: number }[]
        }
      }
    ).__orcaAwakePowerProbe
    const starts = probe?.starts ?? []
    return {
      starts: starts.map((start) => ({ ...start })),
      stops: (probe?.stops ?? []).map((stop) => ({ ...stop })),
      activeIds: starts.map((start) => start.id).filter((id) => powerSaveBlocker.isStarted(id))
    }
  })
}

async function readMacosSleepAssertionPids(electronApp: ElectronApplication): Promise<number[]> {
  const result = await runProcess({
    program: '/usr/bin/pgrep',
    args: ['-P', String(electronApp.process().pid), '-f', '^/usr/bin/caffeinate -i -s$'],
    maxOutputBytes: 4_096
  })
  if (result.code === 1) {
    return []
  }
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number)
}

async function postCodexHookEvent(
  electronApp: ElectronApplication,
  options: {
    paneKey: string
    tabId: string
    eventName: 'UserPromptSubmit' | 'Stop'
  }
): Promise<void> {
  const endpoint = await readHookEndpoint(electronApp)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey: options.paneKey,
      tabId: options.tabId,
      worktreeId: 'e2e-awake-worktree',
      env: endpoint.env,
      version: endpoint.version,
      payload: {
        hook_event_name: options.eventName,
        prompt: 'e2e keep-awake prompt'
      }
    })
  })
  expect(response.status).toBe(204)
}

test.describe('Agent awake setting', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('keeps the OS awake only while a hook-reported agent is working', async ({
    electronApp,
    orcaPage
  }) => {
    if (process.platform !== 'darwin') {
      await installPowerSaveBlockerProbe(electronApp)
    }
    await setKeepAwake(orcaPage, true)

    const tabId = 'e2e-awake-tab'
    const paneKey = `${tabId}:${randomUUID()}`
    await postCodexHookEvent(electronApp, {
      paneKey,
      tabId,
      eventName: 'UserPromptSubmit'
    })

    await expect(
      orcaPage.getByRole('button', { name: 'Keep computer awake, Agent · Active' })
    ).toBeVisible()
    let startedIds: number[] = []
    if (process.platform === 'darwin') {
      // macOS uses an app-owned caffeinate assertion instead of Electron's blocker.
      await expect
        .poll(() => readMacosSleepAssertionPids(electronApp), { timeout: 5_000 })
        .not.toEqual([])
    } else {
      await expect
        .poll(async () => await readPowerSaveBlockerProbe(electronApp), {
          timeout: 5_000,
          message: 'powerSaveBlocker did not start for the working agent'
        })
        .toEqual(
          expect.objectContaining({
            activeIds: expect.arrayContaining([expect.any(Number)]),
            starts: expect.arrayContaining([
              expect.objectContaining({
                type:
                  process.platform === 'win32' ? 'prevent-display-sleep' : 'prevent-app-suspension'
              })
            ])
          })
        )

      startedIds = (await readPowerSaveBlockerProbe(electronApp)).starts.map((start) => start.id)
      expect(startedIds.length).toBeGreaterThan(0)
    }

    await postCodexHookEvent(electronApp, {
      paneKey,
      tabId,
      eventName: 'Stop'
    })

    await expect(
      orcaPage.getByRole('button', { name: 'Keep computer awake, Agent · Inactive' })
    ).toBeVisible()
    if (process.platform === 'darwin') {
      await expect
        .poll(() => readMacosSleepAssertionPids(electronApp), { timeout: 5_000 })
        .toEqual([])
      return
    }
    await expect
      .poll(async () => await readPowerSaveBlockerProbe(electronApp), {
        timeout: 5_000,
        message: 'powerSaveBlocker stayed active after the agent stopped'
      })
      .toEqual(
        expect.objectContaining({
          activeIds: [],
          stops: expect.arrayContaining(startedIds.map((id) => expect.objectContaining({ id })))
        })
      )
  })
})
