import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-lossy-snapshot-'))
const fixturePath = path.join(scratch, 'lossy-snapshot-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    'import { readFileSync } from "node:fs"',
    'const marker = readFileSync(process.argv[2], "utf8")',
    'process.stdout.write(`${marker}\\r\\n`)',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.on("data", (data) => process.stdout.write(`LIVE:${data.trim()}\\r\\n`))',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))
test.use({
  orcaAppExtraEnv: { ORCA_E2E_FORCE_REMOTE_TERMINAL_INITIAL_SNAPSHOT_TRUNCATED: '1' }
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(marker: string): string {
  const command = [process.execPath, fixturePath, marker]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

async function callRuntime<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

async function callLocalRuntime<TResult>(
  page: Page,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

test('paints a nonempty lossy initial snapshot on a paired Electron client @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  const marker = `REMOTE_LOSSY_INITIAL_${Date.now()}`
  const liveMarker = `REMOTE_LOSSY_LIVE_${Date.now()}`
  const markerPath = path.join(scratch, 'marker-value.txt')
  writeFileSync(markerPath, marker)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'lossy-initial-snapshot')
  let terminal: string | null = null
  try {
    const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
    if (!worktreeId) {
      throw new Error('Headed host has no active worktree')
    }
    await orcaPage.evaluate((id) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(id)
    }, worktreeId)
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(worktreeId)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id) ?? false,
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    const created = await callLocalRuntime<{
      tab: { parentTabId: string; terminal: string | null }
    }>(orcaPage, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      command: fixtureCommand(markerPath),
      activate: true,
      select: true,
      navigation: 'host'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Paired host did not publish the fixture terminal')
    }
    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await expect
      .poll(
        async () => {
          const result = await callLocalRuntime<{ terminal: RuntimeTerminalRead }>(
            orcaPage,
            'terminal.read',
            { terminal, screen: true }
          )
          return result.terminal.tail.join('\n').includes(marker)
        },
        { timeout: 30_000 }
      )
      .toBe(true)
    const { terminal: hostEvidence } = await callLocalRuntime<{ terminal: RuntimeTerminalRead }>(
      orcaPage,
      'terminal.read',
      { terminal, screen: true }
    )
    console.log(
      `[lossy-initial] ${JSON.stringify({ hostLatestCursor: hostEvidence?.latestCursor, hostNextCursor: hostEvidence?.nextCursor, marker })}`
    )

    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: webTabId, worktreeId }
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await client.page.evaluate(
      ({ tabId, worktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(worktreeId)
        state?.setActiveTab(tabId)
        state?.setActiveTabType('terminal')
      },
      { tabId: webTabId, worktreeId }
    )
    const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await expect(tab).toHaveAttribute('data-active', 'true')
    await expect
      .poll(
        () =>
          client.page.evaluate((id) => {
            const manager = window.__paneManagers?.get(id)
            const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
            return {
              mounted: Boolean(pane),
              markerCount:
                (pane?.serializeAddon?.serialize?.() ?? '').split('REMOTE_LOSSY_INITIAL_').length -
                1
            }
          }, webTabId),
        { timeout: 30_000 }
      )
      .toEqual({ mounted: true, markerCount: 1 })

    const beforeLiveCursor = Number(hostEvidence?.latestCursor)
    const sent = await callRuntime<{ send: { accepted: boolean } }>(
      client.page,
      client.environmentId,
      'terminal.send',
      {
        terminal,
        text: liveMarker,
        enter: true,
        client: { id: 'paired-lossy-initial-e2e', type: 'desktop' }
      }
    )
    expect(sent.send.accepted).toBe(true)
    await expect
      .poll(() =>
        client.page.evaluate(
          () =>
            (
              window as Window & {
                __remoteTerminalMultiplexAckGate?: {
                  snapshot: () => { initialSnapshotTruncatedCount?: number }
                }
              }
            ).__remoteTerminalMultiplexAckGate?.snapshot().initialSnapshotTruncatedCount
        )
      )
      .toBeGreaterThanOrEqual(1)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ initialMarker, liveMarker, tabId }) => {
              const manager = window.__paneManagers?.get(tabId)
              const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
              const content = pane?.serializeAddon?.serialize?.() ?? ''
              return {
                initialMarkerCount: content.split(initialMarker).length - 1,
                liveMarkerCount: content.split(`LIVE:${liveMarker}`).length - 1
              }
            },
            { initialMarker: marker, liveMarker, tabId: webTabId }
          ),
        { timeout: 30_000 }
      )
      .toEqual({ initialMarkerCount: 1, liveMarkerCount: 1 })
    const clientWindow = await client.app.browserWindow(client.page)
    await clientWindow.evaluate((window) => {
      window.show()
      window.focus()
    })
    await expect.poll(() => clientWindow.evaluate((window) => window.isVisible())).toBe(true)
    await client.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    await testInfo.attach('paired-client-lossy-initial-restored', {
      body: await client.page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png'
    })
    await expect
      .poll(
        async () => {
          const result = await callLocalRuntime<{ terminal: RuntimeTerminalRead }>(
            orcaPage,
            'terminal.read',
            { terminal, screen: true }
          )
          return Number(result.terminal.latestCursor)
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(beforeLiveCursor)
  } finally {
    if (terminal) {
      await callRuntime(client.page, client.environmentId, 'terminal.closeTab', { terminal }).catch(
        () => undefined
      )
    }
    await client.dispose()
  }
})
