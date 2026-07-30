import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-types'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { getTerminalContent, waitForActivePanePtyId } from './helpers/terminal'

const RETENTION_PARK_DELAY_MS = 100
const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-truncated-tail-'))
const fixturePath = path.join(scratch, 'truncated-tail-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    'const marker = process.argv[2]',
    'let flooded = false',
    "process.stdout.write('REMOTE_TRUNCATED_TAIL_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (data) => {",
    "  if (!flooded && data.includes('GO')) {",
    '    flooded = true',
    "    for (let row = 0; row < 4_000; row += 1) process.stdout.write(`overflow-${row}-${'x'.repeat(80)}\\r\\n`)",
    '    process.stdout.write(`${marker}\\r\\n`)',
    '    return',
    '  }',
    '  process.stdout.write(`LIVE:${data.trim()}\\r\\n`)',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

test.use({
  orcaAppExtraEnv: {
    ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(RETENTION_PARK_DELAY_MS),
    ORCA_E2E_TERMINAL_RETENTION_LIMIT: '1'
  }
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

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
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

test('paints a paired remote terminal when only its retained text tail overflowed @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(120_000)
  const firstPaintMarker = `REMOTE_TRUNCATED_TAIL_FIRST_PAINT_${Date.now()}`
  const liveMarker = `REMOTE_TRUNCATED_TAIL_LIVE_${Date.now()}`
  const worktree = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const activeWorktreeId = state?.activeWorktreeId
    if (!activeWorktreeId) {
      throw new Error('Headed host did not select its seeded worktree')
    }
    const activeWorktree = state
      .allWorktrees()
      .find((candidate) => candidate.id === activeWorktreeId)
    if (!activeWorktree) {
      throw new Error('Headed host active worktree was absent from inventory')
    }
    return { id: activeWorktree.id, path: activeWorktree.path }
  })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer)
  let terminal: string | null = null
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (worktreeId) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((candidate) => candidate.id === worktreeId),
            worktree.id
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const created = await callRuntime<{
      tab: {
        parentTabId: string
        leafId: string
        terminal: string | null
      }
    }>(client.page, 'session.tabs.createTerminal', {
      worktree: `id:${worktree.id}`,
      command: fixtureCommand(firstPaintMarker),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Paired runtime did not publish the overflow fixture terminal')
    }

    const webTabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ tabId, worktreeId }) =>
              (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                (tab) => tab.id === tabId
              ),
            { tabId: webTabId, worktreeId: worktree.id }
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    await client.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const remoteTab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`)
    await expect(remoteTab).toBeVisible({ timeout: 30_000 })
    await remoteTab.click()
    await expect(remoteTab).toHaveAttribute('data-active', 'true')
    await waitForActivePanePtyId(client.page, 30_000)
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('REMOTE_TRUNCATED_TAIL_READY')
    await callRuntime(client.page, 'terminal.send', {
      terminal,
      text: 'WARMUP',
      enter: true,
      client: { id: 'paired-truncated-tail-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('LIVE:WARMUP')
    await callRuntime(client.page, 'terminal.send', {
      terminal,
      text: 'GO',
      enter: true,
      client: { id: 'paired-truncated-tail-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(firstPaintMarker)
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            client.page,
            'terminal.read',
            { terminal }
          )
          return {
            marker: result.terminal.tail.join('\n').includes(firstPaintMarker),
            truncated: result.terminal.truncated
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({ marker: true, truncated: true })

    await client.page.reload()
    await client.page.locator('[data-worktree-sidebar]').waitFor({
      state: 'visible',
      timeout: 30_000
    })
    await client.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId),
      worktree.id
    )
    const restoredRemoteTab = client.page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`
    )
    await expect(restoredRemoteTab).toBeVisible({ timeout: 30_000 })
    await restoredRemoteTab.click()
    await expect(restoredRemoteTab).toHaveAttribute('data-active', 'true')
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(firstPaintMarker)

    await callRuntime(client.page, 'terminal.send', {
      terminal,
      text: liveMarker,
      enter: true,
      client: { id: 'paired-truncated-tail-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
  } finally {
    if (terminal) {
      await callRuntime(client.page, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
  }
})

test('legacy paired hosts retain the lossy hidden-manager budget fallback @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(
    process.env.ORCA_E2E_DISABLE_PAIRED_TERMINAL_PARKING !== '1',
    'The legacy fallback requires a host without terminal.paired-parking.v1.'
  )
  test.setTimeout(120_000)
  const worktreeIds = await orcaPage.evaluate(() =>
    window.__store
      ?.getState()
      .allWorktrees()
      .slice(0, 2)
      .map((worktree) => worktree.id)
  )
  if (!worktreeIds || worktreeIds.length < 2) {
    throw new Error('Paired retention fixture requires two seeded worktrees')
  }
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer, {
    terminalParkingDelayMs: RETENTION_PARK_DELAY_MS,
    terminalRetentionLimit: 1
  })
  const createdTerminals: string[] = []
  try {
    expect(await client.page.evaluate(() => window.api.e2e.getConfig())).toMatchObject({
      exposeStore: true,
      terminalParkingDelayMs: RETENTION_PARK_DELAY_MS,
      terminalRetentionLimit: 1
    })
    expect(
      await client.page.evaluate(
        (capability) =>
          Array.from(window.__store?.getState().runtimeStatusByEnvironmentId.values() ?? []).some(
            (entry) => entry.status?.capabilities?.includes(capability)
          ),
        TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY
      )
    ).toBe(false)
    await expect
      .poll(
        () =>
          client.page.evaluate((ids) => {
            const known = new Set(
              window.__store
                ?.getState()
                .allWorktrees()
                .map((worktree) => worktree.id)
            )
            return ids.every((id) => known.has(id))
          }, worktreeIds),
        { timeout: 30_000 }
      )
      .toBe(true)
    await client.page.evaluate(async () => {
      await window.__store
        ?.getState()
        .updateSettings({ terminalHiddenWorktreeRetentionBudget: false })
    })

    const remoteTabs: { tabId: string; terminal: string; worktreeId: string; marker: string }[] = []
    for (const [index, worktreeId] of worktreeIds.entries()) {
      const marker = `PAIRED_RETENTION_${index}_${Date.now()}`
      const created = await callRuntime<{
        tab: { parentTabId: string; terminal: string | null }
      }>(client.page, 'session.tabs.createTerminal', {
        worktree: `id:${worktreeId}`,
        command: fixtureCommand(marker),
        activate: false,
        select: false,
        navigation: 'caller'
      })
      if (!created.tab.terminal) {
        throw new Error(`Paired retention terminal ${index} was not published`)
      }
      createdTerminals.push(created.tab.terminal)
      const tabId = toWebTerminalSurfaceTabId(created.tab.parentTabId)
      await expect
        .poll(
          () =>
            client.page.evaluate(
              ({ tabId, worktreeId }) =>
                (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
                  (tab) => tab.id === tabId
                ),
              { tabId, worktreeId }
            ),
          { timeout: 30_000 }
        )
        .toBe(true)
      await client.page.evaluate(
        (id) => window.__store?.getState().setActiveWorktree(id),
        worktreeId
      )
      const tab = client.page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
      await expect(tab).toBeVisible({ timeout: 30_000 })
      await tab.click()
      await waitForActivePanePtyId(client.page, 30_000)
      await callRuntime(client.page, 'terminal.send', {
        terminal: created.tab.terminal,
        text: marker,
        enter: true,
        client: { id: 'paired-retention-e2e', type: 'desktop' }
      })
      await expect
        .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
        .toContain(`LIVE:${marker}`)
      remoteTabs.push({ tabId, terminal: created.tab.terminal, worktreeId, marker })
    }

    await expect
      .poll(
        () =>
          client.page.evaluate(() => ({
            parkDelayMs: window.__terminalParkingDebug?.parkDelayMs,
            retentionLimit: window.__terminalParkingDebug?.retentionLimit
          })),
        { timeout: 10_000 }
      )
      .toEqual({ parkDelayMs: RETENTION_PARK_DELAY_MS, retentionLimit: 1 })

    await client.page.evaluate(() => window.__store?.getState().setActiveView('tasks'))
    const controlStartedAt = Date.now()
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ tabIds, controlStartedAt, delayMs }) => ({
              heldLongEnough: Date.now() - controlStartedAt >= delayMs * 4,
              mounted: tabIds.filter((tabId) => window.__paneManagers?.has(tabId)).length
            }),
            {
              tabIds: remoteTabs.map((tab) => tab.tabId),
              controlStartedAt,
              delayMs: RETENTION_PARK_DELAY_MS
            }
          ),
        { timeout: 10_000 }
      )
      .toEqual({ heldLongEnough: true, mounted: 2 })

    await client.page.evaluate(async () => {
      await window.__store
        ?.getState()
        .updateSettings({ terminalHiddenWorktreeRetentionBudget: true })
    })
    await expect
      .poll(
        () =>
          client.page.evaluate(
            ({ delayMs, tabIds: [olderTabId, newerTabId], worktreeIds }) => {
              const state = window.__store?.getState()
              const terminalTabs = Object.values(state?.tabsByWorktree ?? {}).flat()
              const verdicts = window.__terminalParkingDebug?.worktreeVerdicts() ?? []
              return {
                activeView: state?.activeView,
                budgetEnabled: state?.settings?.terminalHiddenWorktreeRetentionBudget,
                newerMounted: window.__paneManagers?.has(newerTabId),
                olderMounted: window.__paneManagers?.has(olderTabId),
                remotePtys: [olderTabId, newerTabId].map((tabId) =>
                  terminalTabs.find((tab) => tab.id === tabId)?.ptyId?.startsWith('remote:')
                ),
                verdicts: worktreeIds.map((worktreeId) => {
                  const verdict = verdicts.find((candidate) => candidate.worktreeId === worktreeId)
                  return verdict
                    ? {
                        forceParked: verdict.forceParked,
                        hasActivityTerminalPortal: verdict.hasActivityTerminalPortal,
                        hasPendingSpawnWork: verdict.hasPendingSpawnWork,
                        hidden: verdict.hiddenSinceMs !== null,
                        hiddenPastDelay:
                          verdict.hiddenSinceMs !== null &&
                          Date.now() - verdict.hiddenSinceMs >= delayMs,
                        isVisible: verdict.isVisible,
                        ordinaryParkingCovers: verdict.ordinaryParkingCovers,
                        parkCooldown:
                          verdict.parkCooldownUntilMs !== null &&
                          Date.now() < verdict.parkCooldownUntilMs,
                        shouldMeasureHiddenWorktree: verdict.shouldMeasureHiddenWorktree
                      }
                    : null
                })
              }
            },
            {
              delayMs: RETENTION_PARK_DELAY_MS,
              tabIds: [remoteTabs[0]!.tabId, remoteTabs[1]!.tabId],
              worktreeIds
            }
          ),
        { timeout: 10_000 }
      )
      .toEqual({
        activeView: 'tasks',
        budgetEnabled: true,
        newerMounted: true,
        olderMounted: false,
        remotePtys: [true, true],
        verdicts: [
          {
            forceParked: true,
            hasActivityTerminalPortal: false,
            hasPendingSpawnWork: false,
            hidden: true,
            hiddenPastDelay: true,
            isVisible: false,
            ordinaryParkingCovers: false,
            parkCooldown: false,
            shouldMeasureHiddenWorktree: false
          },
          {
            forceParked: false,
            hasActivityTerminalPortal: false,
            hasPendingSpawnWork: false,
            hidden: true,
            hiddenPastDelay: true,
            isVisible: false,
            ordinaryParkingCovers: false,
            parkCooldown: false,
            shouldMeasureHiddenWorktree: false
          }
        ]
      })

    const older = remoteTabs[0]!
    await client.page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
    }, older.worktreeId)
    const olderTab = client.page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${older.tabId}"]`
    )
    await expect(olderTab).toBeVisible({ timeout: 30_000 })
    await olderTab.click()
    await waitForActivePanePtyId(client.page, 30_000)
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain(`LIVE:${older.marker}`)
    await callRuntime(client.page, 'terminal.send', {
      terminal: older.terminal,
      text: 'AFTER_RESTORE',
      enter: true,
      client: { id: 'paired-retention-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(client.page), { timeout: 30_000 })
      .toContain('LIVE:AFTER_RESTORE')
    await expect(olderTab).toHaveAttribute('data-active', 'true')
  } finally {
    for (const terminal of createdTerminals) {
      await callRuntime(client.page, 'terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client.dispose()
  }
})
