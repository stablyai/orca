import type { Page } from '@stablyai/playwright-test'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { toWebTerminalSurfaceTabId } from '../../../src/shared/terminal-surface-id'
import { expect } from './orca-app'
import {
  callColdActivationRuntime,
  expectStableColdActivationMountState,
  readColdActivationMountState
} from './paired-terminal-cold-activation-observation'
import { createPairedTerminalParkingFixture } from './paired-terminal-parking-fixture'
import { getTerminalContent, waitForActivePanePtyId } from './terminal'

const TARGET_TAB_COUNT = 8

type ColdTab = {
  marker: string
  originalPtyId: string
  tabId: string
  terminal: string
}

export async function runPairedTerminalColdActivationOracle(
  page: Page,
  seed: { repoId: string }
): Promise<void> {
  const fixture = createPairedTerminalParkingFixture()
  const handles: string[] = []
  const createdWorktreeIds: string[] = []
  let fallbackWorktreeId: string | null = null
  let worktreeId: string | null = null
  try {
    await expect
      .poll(
        () =>
          page.evaluate((capability) => {
            const state = window.__store?.getState()
            const statuses = Array.from(state?.runtimeStatusByEnvironmentId.entries() ?? [])
            return JSON.stringify({
              capable: statuses.some(([, entry]) =>
                entry.status?.capabilities?.includes(capability)
              ),
              statuses: statuses.map(([environmentId, entry]) => ({
                capabilities: entry.status?.capabilities ?? [],
                environmentId,
                hasStatus: entry.status != null
              })),
              workspaces: state?.allWorktrees().length ?? 0,
              workspaceSessionReady: state?.workspaceSessionReady ?? false
            })
          }, TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY),
        { timeout: 30_000 }
      )
      .toContain('"capable":true')

    const fallback = await callColdActivationRuntime<{
      startupTerminal?: { handle?: string; tabId?: string }
      worktree: { id: string }
    }>(page, 'worktree.create', {
      repo: seed.repoId,
      name: `paired-cold-fallback-${Date.now()}`,
      setupDecision: 'skip',
      activate: false,
      noParent: true,
      startupCommand: fixture.command('PAIR_COLD_FALLBACK')
    })
    fallbackWorktreeId = fallback.worktree.id
    createdWorktreeIds.push(fallbackWorktreeId)
    if (!fallback.startupTerminal?.handle || !fallback.startupTerminal.tabId) {
      throw new Error('Paired cold-activation fallback terminal was not created')
    }
    handles.push(fallback.startupTerminal.handle)
    const fallbackTabId = toWebTerminalSurfaceTabId(fallback.startupTerminal.tabId)
    await page.evaluate(
      ({ tabId, targetWorktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveTabForWorktree(targetWorktreeId, tabId)
        state?.setActiveView('terminal')
        state?.setActiveWorktree(targetWorktreeId)
      },
      { tabId: fallbackTabId, targetWorktreeId: fallbackWorktreeId }
    )
    const fallbackTab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${fallbackTabId}"]`)
    await expect(fallbackTab).toBeVisible({ timeout: 30_000 })
    await fallbackTab.click()
    await expect(fallbackTab).toHaveAttribute('data-active', 'true')

    const firstMarker = 'PAIR_COLD_ACTIVATION_0'
    const created = await callColdActivationRuntime<{
      startupTerminal?: { handle?: string; tabId?: string }
      worktree: { id: string }
    }>(page, 'worktree.create', {
      repo: seed.repoId,
      name: `paired-cold-activation-${Date.now()}`,
      setupDecision: 'skip',
      activate: false,
      noParent: true,
      startupCommand: fixture.command(firstMarker)
    })
    worktreeId = created.worktree.id
    createdWorktreeIds.push(worktreeId)
    if (!created.startupTerminal?.handle || !created.startupTerminal.tabId) {
      throw new Error('Paired cold-activation startup terminal was not created')
    }
    handles.push(created.startupTerminal.handle)
    const pendingTabs = [
      {
        marker: firstMarker,
        tabId: toWebTerminalSurfaceTabId(created.startupTerminal.tabId),
        terminal: created.startupTerminal.handle
      }
    ]

    while (pendingTabs.length < TARGET_TAB_COUNT) {
      const marker = `PAIR_COLD_ACTIVATION_${pendingTabs.length}`
      const result = await callColdActivationRuntime<{
        tab: { parentTabId: string; terminal: string | null }
      }>(page, 'session.tabs.createTerminal', {
        worktree: `id:${worktreeId}`,
        command: fixture.command(marker),
        activate: false,
        select: false,
        navigation: 'caller'
      })
      if (!result.tab.terminal) {
        throw new Error(`Paired cold-activation terminal ${pendingTabs.length} was not created`)
      }
      handles.push(result.tab.terminal)
      pendingTabs.push({
        marker,
        tabId: toWebTerminalSurfaceTabId(result.tab.parentTabId),
        terminal: result.tab.terminal
      })
    }

    let originalPtyIds: string[] | null = null
    await expect
      .poll(
        async () => {
          originalPtyIds = await page.evaluate(
            ({ tabIds, targetWorktreeId }) => {
              const tabs = window.__store?.getState().tabsByWorktree[targetWorktreeId] ?? []
              const byId = new Map(tabs.map((tab) => [tab.id, tab.ptyId]))
              const ids = tabIds.map((id) => byId.get(id) ?? null)
              return ids.every((id): id is string => typeof id === 'string') ? ids : null
            },
            {
              tabIds: pendingTabs.map((tab) => tab.tabId),
              targetWorktreeId: worktreeId
            }
          )
          return originalPtyIds
        },
        { timeout: 30_000 }
      )
      .not.toBeNull()
    if (originalPtyIds === null) {
      throw new Error('Paired cold-activation PTY ids were not captured')
    }
    const tabs: ColdTab[] = pendingTabs.map((tab, index) => ({
      ...tab,
      originalPtyId: originalPtyIds[index]!
    }))
    const tabIds = tabs.map((tab) => tab.tabId)
    expect(await readColdActivationMountState(page, tabIds)).toEqual({ mounted: 0, parked: 0 })

    await page.evaluate(
      ({ activeTabId, targetWorktreeId }) => {
        const state = window.__store?.getState()
        state?.setActiveTabForWorktree(targetWorktreeId, activeTabId)
        state?.setActiveView('terminal')
        state?.setActiveWorktree(targetWorktreeId)
      },
      { activeTabId: tabs[0].tabId, targetWorktreeId: worktreeId }
    )
    const firstTab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabs[0].tabId}"]`)
    await expect(firstTab).toBeVisible({ timeout: 30_000 })
    await expect(firstTab).toHaveAttribute('data-active', 'true')
    await expectStableColdActivationMountState(page, tabIds, {
      mounted: 1,
      parked: TARGET_TAB_COUNT - 1
    })
    expect(await waitForActivePanePtyId(page, 30_000)).toBe(tabs[0].originalPtyId)

    const deferred = tabs[4]
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalHiddenViewParking: false })
    })
    await expectStableColdActivationMountState(page, tabIds, {
      mounted: TARGET_TAB_COUNT,
      parked: 0
    })
    const deferredTab = page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${deferred.tabId}"]`
    )
    await deferredTab.click()
    await expect(deferredTab).toHaveAttribute('data-active', 'true')
    expect(await waitForActivePanePtyId(page, 30_000)).toBe(deferred.originalPtyId)
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`READY:${deferred.marker}`)
    await firstTab.click()
    await expect(firstTab).toHaveAttribute('data-active', 'true')
    await page.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalHiddenViewParking: true })
    })
    await expectStableColdActivationMountState(page, tabIds, {
      mounted: 2,
      parked: TARGET_TAB_COUNT - 2
    })

    await page.evaluate(
      (fallbackWorktreeId) => window.__store?.getState().setActiveWorktree(fallbackWorktreeId),
      fallbackWorktreeId
    )
    await expect(firstTab).not.toBeVisible()
    await page.evaluate(
      (targetWorktreeId) => window.__store?.getState().setActiveWorktree(targetWorktreeId),
      worktreeId
    )
    await expect(firstTab).toHaveAttribute('data-active', 'true')
    await expectStableColdActivationMountState(page, tabIds, {
      mounted: 2,
      parked: TARGET_TAB_COUNT - 2
    })

    const secondTab = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabs[1].tabId}"]`)
    await secondTab.click()
    await expect(secondTab).toHaveAttribute('data-active', 'true')
    await expectStableColdActivationMountState(page, tabIds, {
      mounted: 2,
      parked: TARGET_TAB_COUNT - 2
    })

    await page.evaluate(
      (fallbackWorktreeId) => window.__store?.getState().setActiveWorktree(fallbackWorktreeId),
      fallbackWorktreeId
    )
    await expect(secondTab).not.toBeVisible()
    await page.evaluate(
      (targetWorktreeId) => window.__store?.getState().setActiveWorktree(targetWorktreeId),
      worktreeId
    )
    await expect(secondTab).toHaveAttribute('data-active', 'true')
    await expectStableColdActivationMountState(page, tabIds, {
      mounted: 2,
      parked: TARGET_TAB_COUNT - 2
    })

    const deferredMarker = `PAIR_COLD_DEFERRED_${Date.now()}`
    const sent = await callColdActivationRuntime<{ send: { accepted: boolean } }>(
      page,
      'terminal.send',
      {
        terminal: deferred.terminal,
        text: deferredMarker,
        enter: true
      }
    )
    expect(sent.send.accepted).toBe(true)

    await deferredTab.click()
    await expect(deferredTab).toHaveAttribute('data-active', 'true')
    await expectStableColdActivationMountState(page, tabIds, {
      mounted: 2,
      parked: TARGET_TAB_COUNT - 2
    })
    expect(await waitForActivePanePtyId(page, 30_000)).toBe(deferred.originalPtyId)
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`READY:${deferred.marker}`)
    await expect
      .poll(() => getTerminalContent(page), { timeout: 30_000 })
      .toContain(`LIVE:${deferredMarker}`)
  } finally {
    for (const terminal of handles) {
      await callColdActivationRuntime(page, 'terminal.closeTab', { terminal }).catch(
        () => undefined
      )
    }
    await page
      .evaluate(() => window.__store?.getState().setActiveWorktree(null))
      .catch(() => undefined)
    for (const createdWorktreeId of createdWorktreeIds.toReversed()) {
      await callColdActivationRuntime(page, 'worktree.rm', {
        worktree: `id:${createdWorktreeId}`,
        force: true,
        runHooks: false
      }).catch(() => undefined)
    }
    fixture.dispose()
  }
}
