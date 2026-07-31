import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../../src/shared/runtime-types'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '../../../src/shared/terminal-surface-id'
import {
  readPairedRetentionSample,
  startRendererLagProbe
} from '../paired-runtime-retention-metrics'
import { expect } from './orca-app'
import { verifyHiddenPairedTerminalOutputSuppression } from './paired-terminal-hidden-output-oracle'
import { createPairedTerminalParkingFixture } from './paired-terminal-parking-fixture'
import { getTerminalContent, waitForActivePanePtyId } from './terminal'

const TARGET_WORKTREE_COUNT = 6
const MIN_STAGED_BUFFER_CELLS = 1_000_000
const MAX_RETAINED_CELL_FRACTION = 0.45
const MAX_EVICTION_LAG_MS = 500
const MAX_HEAP_GROWTH_BYTES = 16 * 1024 * 1024

type RemoteTab = {
  marker: string
  originalPtyId: string
  tabId: string
  terminal: string
  worktreeId: string
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

export async function runPairedTerminalParkingOracle(
  page: Page,
  seed: { fallbackWorktreeId: string; repoId: string },
  options: { hostPage?: Page } = {}
): Promise<void> {
  const fixture = createPairedTerminalParkingFixture()
  const createdWorktreeIds: string[] = []
  const remoteTabs: RemoteTab[] = []
  try {
    await expect
      .poll(
        () =>
          page.evaluate((capability) => {
            const statuses = window.__store?.getState().runtimeStatusByEnvironmentId.values() ?? []
            return Array.from(statuses).some((entry) =>
              entry.status?.capabilities?.includes(capability)
            )
          }, TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY),
        { timeout: 30_000 }
      )
      .toBe(true)
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        terminalHiddenViewParking: false,
        terminalHiddenWorktreeRetentionBudget: false
      })
    })
    const createdTerminals: Omit<RemoteTab, 'originalPtyId'>[] = []
    while (createdTerminals.length < TARGET_WORKTREE_COUNT) {
      const index = createdTerminals.length
      const marker = `PAIR_RETENTION_${index}`
      const suffix = `${Date.now()}-${index}`
      const created = await callRuntime<{
        startupTerminal?: { handle?: string; tabId?: string }
        worktree: { id: string }
      }>(page, 'worktree.create', {
        repo: seed.repoId,
        name: `paired-retention-${suffix}`,
        setupDecision: 'skip',
        activate: false,
        noParent: true,
        startupCommand: fixture.command(marker)
      })
      if (!created.startupTerminal?.handle || !created.startupTerminal.tabId) {
        throw new Error(`Paired retention startup terminal ${index} was not created`)
      }
      createdWorktreeIds.push(created.worktree.id)
      createdTerminals.push({
        marker,
        tabId: toWebTerminalSurfaceTabId(created.startupTerminal.tabId),
        terminal: created.startupTerminal.handle,
        worktreeId: created.worktree.id
      })
    }
    await expect
      .poll(
        () =>
          page.evaluate(
            (ids) =>
              ids.every((id) =>
                window.__store
                  ?.getState()
                  .allWorktrees()
                  .some((worktree) => worktree.id === id)
              ),
            createdWorktreeIds
          ),
        { timeout: 30_000 }
      )
      .toBe(true)

    for (const created of createdTerminals) {
      await page.evaluate(
        (id) => window.__store?.getState().setActiveWorktree(id),
        created.worktreeId
      )
      const tab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${created.tabId}"]`)
      await expect(tab).toBeVisible({ timeout: 30_000 })
      await tab.click()
      const originalPtyId = await waitForActivePanePtyId(page, 30_000)
      await callRuntime(page, 'terminal.send', {
        terminal: created.terminal,
        text: 'FILL',
        enter: true,
        client: { id: 'paired-retention-memory-e2e', type: 'desktop' }
      })
      await expect
        .poll(() => getTerminalContent(page), { timeout: 30_000 })
        .toContain(`FILLED:${created.marker}`)
      remoteTabs.push({ ...created, originalPtyId })
    }
    await expectHostTerminalsUnmounted(options.hostPage, seed.fallbackWorktreeId, remoteTabs)

    const hiddenFloodTokens = await verifyHiddenPairedTerminalOutputSuppression(page, remoteTabs)
    const baseline = await readPairedRetentionSample(
      page,
      remoteTabs.map((tab) => tab.tabId)
    )
    expect(baseline.bufferCells).toBeGreaterThan(MIN_STAGED_BUFFER_CELLS)

    const lagProbe = await startRendererLagProbe(page)
    let maxLagMs = Number.POSITIVE_INFINITY
    let lagProbeStopped = false
    try {
      await page.evaluate(async () => {
        await window.__store?.getState().updateSettings({ terminalHiddenViewParking: true })
      })
      await expect
        .poll(
          () =>
            page.evaluate(
              ({ tabIds, worktreeIds }) => {
                const verdicts = window.__terminalParkingDebug?.worktreeVerdicts() ?? []
                return {
                  forceParked: worktreeIds.map(
                    (id) => verdicts.find((verdict) => verdict.worktreeId === id)?.forceParked
                  ),
                  mounted: tabIds.filter((id) => window.__paneManagers?.has(id)).length,
                  ordinaryParkingCovers: worktreeIds.map(
                    (id) =>
                      verdicts.find((verdict) => verdict.worktreeId === id)?.ordinaryParkingCovers
                  ),
                  parked: window.__terminalParkingDebug?.parkedTabIds().length,
                  retentionBudgetEnabled:
                    window.__store?.getState().settings?.terminalHiddenWorktreeRetentionBudget
                }
              },
              {
                tabIds: remoteTabs.map((tab) => tab.tabId),
                worktreeIds: remoteTabs.map((tab) => tab.worktreeId)
              }
            ),
          { timeout: 10_000 }
        )
        .toEqual({
          forceParked: Array(TARGET_WORKTREE_COUNT).fill(false),
          mounted: 1,
          ordinaryParkingCovers: Array(TARGET_WORKTREE_COUNT).fill(true),
          parked: TARGET_WORKTREE_COUNT - 1,
          retentionBudgetEnabled: false
        })
      maxLagMs = await lagProbe.evaluate((probe) => probe.stop())
      lagProbeStopped = true
    } finally {
      if (!lagProbeStopped) {
        await lagProbe.evaluate((probe) => probe.stop()).catch(() => undefined)
      }
      await lagProbe.dispose()
    }
    const after = await readPairedRetentionSample(
      page,
      remoteTabs.map((tab) => tab.tabId)
    )
    expect(after.bufferCells).toBeLessThanOrEqual(baseline.bufferCells * MAX_RETAINED_CELL_FRACTION)
    expect(after.mountedTargetManagers).toBe(1)
    expect(maxLagMs).toBeLessThan(MAX_EVICTION_LAG_MS)
    if (baseline.heapBytes !== null && after.heapBytes !== null) {
      expect(after.heapBytes).toBeLessThanOrEqual(baseline.heapBytes + MAX_HEAP_GROWTH_BYTES)
    }

    const evicted = await page.evaluate(
      (tabs) => tabs.find((tab) => !window.__paneManagers?.has(tab.tabId)) ?? null,
      remoteTabs
    )
    if (!evicted) {
      throw new Error('Ordinary parking did not unmount a paired terminal')
    }
    const hiddenFloodToken =
      hiddenFloodTokens[remoteTabs.findIndex((tab) => tab.tabId === evicted.tabId)]
    const parkedMarker = `WHILE_PARKED_${Date.now()}`
    await callRuntime(page, 'terminal.send', {
      terminal: evicted.terminal,
      text: parkedMarker,
      enter: true,
      client: { id: 'paired-retention-memory-e2e', type: 'desktop' }
    })
    await expect
      .poll(
        async () => {
          const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
            page,
            'terminal.read',
            { terminal: evicted.terminal, limit: 1_000 }
          )
          return result.terminal.tail.join('\n')
        },
        { timeout: 30_000 }
      )
      .toContain(`LIVE:${parkedMarker}`)

    await page.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
    }, evicted.worktreeId)
    const restored = page.locator(`[data-testid="sortable-tab"][data-tab-id="${evicted.tabId}"]`)
    await expect(restored).toBeVisible({ timeout: 30_000 })
    await restored.click()
    expect(await waitForActivePanePtyId(page, 30_000)).toBe(evicted.originalPtyId)
    await expect
      .poll(
        async () => {
          const content = await getTerminalContent(page, 1_000_000)
          return [
            `flood-${hiddenFloodToken}-3999-`,
            `FLOODED:${hiddenFloodToken}`,
            `LIVE:${parkedMarker}`
          ].map((marker) => content.split(marker).length - 1)
        },
        { timeout: 30_000 }
      )
      .toEqual([1, 1, 1])
    const liveMarker = `AFTER_RETENTION_${Date.now()}`
    await callRuntime(page, 'terminal.send', {
      terminal: evicted.terminal,
      text: liveMarker,
      enter: true,
      client: { id: 'paired-retention-memory-e2e', type: 'desktop' }
    })
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`LIVE:${liveMarker}`)
    await expectHostTerminalsUnmounted(options.hostPage, seed.fallbackWorktreeId, remoteTabs)
  } finally {
    for (const tab of remoteTabs) {
      await callRuntime(page, 'terminal.closeTab', { terminal: tab.terminal }).catch(
        () => undefined
      )
    }
    await page
      .evaluate((id) => window.__store?.getState().setActiveWorktree(id), seed.fallbackWorktreeId)
      .catch(() => undefined)
    for (const worktreeId of createdWorktreeIds.toReversed()) {
      await callRuntime(page, 'worktree.rm', {
        worktree: `id:${worktreeId}`,
        force: true,
        runHooks: false
      }).catch(() => undefined)
    }
    fixture.dispose()
  }
}

async function expectHostTerminalsUnmounted(
  hostPage: Page | undefined,
  activeWorktreeId: string,
  remoteTabs: RemoteTab[]
): Promise<void> {
  if (!hostPage) {
    return
  }
  await expect
    .poll(
      () =>
        hostPage.evaluate(
          (tabIds) => ({
            activeWorktreeId: window.__store?.getState().activeWorktreeId,
            mountedCount: tabIds.filter((tabId) => window.__paneManagers?.has(tabId)).length
          }),
          remoteTabs.map(({ tabId }) => toHostSessionTabId(tabId))
        ),
      { timeout: 30_000 }
    )
    .toEqual({ activeWorktreeId, mountedCount: 0 })
}
