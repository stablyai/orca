import { randomUUID } from 'node:crypto'
import { runProcess } from '../../src/shared/child-process/run-process'
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

async function getSettings(page: Page): Promise<GlobalSettings> {
  return page.evaluate(() => window.api.settings.get())
}

async function setKeepAwake(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const nextSettings = await window.api.settings.set({
      keepComputerAwakeWhileAgentsRun: enabled
    })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  }, enabled)
}

async function setKeepDisplayAwake(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const nextSettings = await window.api.settings.set({ keepDisplayAwake: enabled })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  }, enabled)
}

async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store!.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
}

async function dismissTransientAnnouncement(page: Page): Promise<void> {
  // Why: first-run announcements are independent of this setting and can cover
  // the settings pane on fresh CI profiles before the search input is used.
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  const visible = await maybeLaterButton
    .isVisible({
      timeout: 1_000
    })
    .catch(() => false)
  if (visible) {
    await maybeLaterButton.click()
  }
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

async function readMacosSleepAssertionPids(
  electronApp: ElectronApplication,
  args = '-i -s'
): Promise<number[]> {
  const result = await runProcess({
    program: '/usr/bin/pgrep',
    args: ['-P', String(electronApp.process().pid), '-f', `^/usr/bin/caffeinate ${args}$`],
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

  test('can be changed from Agents settings and persists through IPC', async ({ orcaPage }) => {
    await openSettings(orcaPage)
    await dismissTransientAnnouncement(orcaPage)
    await orcaPage.getByPlaceholder('Search settings').fill('awake')

    await expect(orcaPage.getByText('Keep computer awake').first()).toBeVisible()

    const keepAwakeModes = orcaPage.getByRole('radiogroup', {
      name: 'Keep computer awake'
    })
    const offMode = keepAwakeModes.getByRole('radio', { name: 'Off' })
    const agentMode = keepAwakeModes.getByRole('radio', { name: 'Agent' })

    await expect(offMode).toHaveAttribute('aria-checked', 'true')
    await agentMode.click()
    await expect(agentMode).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(async () => (await getSettings(orcaPage)).computerAwakeMode, {
        timeout: 5_000,
        message: 'keep-awake mode did not persist after selecting Agent'
      })
      .toBe('auto')

    await offMode.click()
    await expect(offMode).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(async () => (await getSettings(orcaPage)).computerAwakeMode, {
        timeout: 5_000,
        message: 'keep-awake mode did not persist after selecting Off'
      })
      .toBe('off')
  })

  test('can enable the display-awake toggle from Agents settings and it persists through IPC', async ({
    orcaPage
  }) => {
    // The row is macOS-only: elsewhere the Electron blocker already blocks display sleep.
    test.skip(process.platform !== 'darwin', 'display-awake toggle is macOS-only')
    await openSettings(orcaPage)
    await dismissTransientAnnouncement(orcaPage)
    // Pin the pane, then search a term only the new row's catalog entry carries:
    // the Agents section is hidden entirely when no catalog entry matches the query.
    await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
    await orcaPage.getByPlaceholder('Search settings').fill('screen lock')

    const displaySwitch = orcaPage.getByRole('switch', { name: 'Keep the display awake' })
    await expect(displaySwitch.first()).toBeVisible()
    // The toggle is inert while the whole keep-awake feature is off.
    await expect(displaySwitch).toBeDisabled()

    // The mode row does not match that query, so clear the search before switching modes.
    await orcaPage.getByPlaceholder('Search settings').fill('')
    const agentMode = orcaPage
      .getByRole('radiogroup', { name: 'Keep computer awake' })
      .getByRole('radio', { name: 'Agent' })
    await agentMode.click()
    await expect(displaySwitch).toBeEnabled()

    await displaySwitch.click()
    await expect
      .poll(async () => (await getSettings(orcaPage)).keepDisplayAwake, {
        timeout: 5_000,
        message: 'keepDisplayAwake did not persist after enabling the toggle'
      })
      .toBe(true)
  })

  test('adds the caffeinate display assertion on macOS and leaves other platforms untouched', async ({
    electronApp,
    orcaPage
  }) => {
    if (process.platform !== 'darwin') {
      await installPowerSaveBlockerProbe(electronApp)
    }
    await setKeepAwake(orcaPage, true)
    await setKeepDisplayAwake(orcaPage, true)

    const tabId = 'e2e-display-awake-tab'
    const paneKey = `${tabId}:${randomUUID()}`
    await postCodexHookEvent(electronApp, {
      paneKey,
      tabId,
      eventName: 'UserPromptSubmit'
    })

    if (process.platform === 'darwin') {
      await expect
        .poll(() => readMacosSleepAssertionPids(electronApp, '-d -i -s'), { timeout: 5_000 })
        .not.toEqual([])

      // Flipping the preference mid-awake restarts the assertion without an app restart.
      await setKeepDisplayAwake(orcaPage, false)
      await expect
        .poll(() => readMacosSleepAssertionPids(electronApp, '-d -i -s'), { timeout: 5_000 })
        .toEqual([])
      await expect
        .poll(() => readMacosSleepAssertionPids(electronApp, '-i -s'), { timeout: 5_000 })
        .not.toEqual([])
      return
    }

    await expect
      .poll(async () => await readPowerSaveBlockerProbe(electronApp), { timeout: 5_000 })
      .toEqual(
        expect.objectContaining({
          starts: expect.arrayContaining([
            expect.objectContaining({ type: 'prevent-display-sleep' })
          ])
        })
      )

    // Off macOS the blocker already blocks display sleep, so the preference must change nothing.
    await setKeepDisplayAwake(orcaPage, false)
    const probe = await readPowerSaveBlockerProbe(electronApp)
    expect(probe.starts.map((start) => start.type)).toEqual(['prevent-display-sleep'])
    expect(probe.stops).toEqual([])
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
      // macOS uses an app-owned caffeinate assertion instead of Electron's display blocker.
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
              expect.objectContaining({ type: 'prevent-display-sleep' })
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
