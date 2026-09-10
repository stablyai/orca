import { expect, test as base } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  activeWorkspaceTabContentType,
  createCanvasResource,
  openMaestro,
  removeWorkspaceResources,
  setTheme
} from './fixtures/maestro-workspace-tab-canvas/evidence'
import {
  PROFILES,
  capture,
  prepareEvidence,
  writeManifest,
  writeMetrics
} from './fixtures/maestro-canvas-agent-topology-performance/evidence'
import { fitCanvas } from './fixtures/maestro-canvas-agent-topology-performance/browser-reveal'

type TerminalIdentity = {
  unifiedTabId: string
  terminalTabId: string
  paneKey: string
  ptyId: string
}

type OrchestrationContext = {
  taskId: string
  dispatchId: string
  displayName: string
  parentPaneKey: string
  coordinatorHandle: string
}

const test = base.extend({
  orcaAppExtraEnv: { ORCA_E2E_MWC_QUERY_DELAY_MS: '250' }
})

async function terminalIdentities(page: Page): Promise<TerminalIdentity[]> {
  return page.evaluate(() => {
    const firstLeaf = (node: unknown): string | null => {
      if (!node || typeof node !== 'object') {
        return null
      }
      const value = node as {
        type?: string
        leafId?: string
        first?: unknown
        second?: unknown
      }
      return value.type === 'leaf'
        ? (value.leafId ?? null)
        : (firstLeaf(value.first) ?? firstLeaf(value.second))
    }
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      return []
    }
    return (state.unifiedTabsByWorktree[worktreeId] ?? []).flatMap((unifiedTab) => {
      if (unifiedTab.contentType !== 'terminal') {
        return []
      }
      const terminalTabId = unifiedTab.entityId
      const layout = state.terminalLayoutsByTabId[terminalTabId]
      const leafId = layout?.activeLeafId ?? firstLeaf(layout?.root)
      const terminalTab = state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === terminalTabId)
      const ptyId = leafId ? (layout?.ptyIdsByLeafId?.[leafId] ?? terminalTab?.ptyId) : null
      return leafId && ptyId
        ? [
            {
              unifiedTabId: unifiedTab.id,
              terminalTabId,
              paneKey: `${terminalTabId}:${leafId}`,
              ptyId
            }
          ]
        : []
    })
  })
}

async function waitForTerminalCount(page: Page, count: number): Promise<TerminalIdentity[]> {
  let identities: TerminalIdentity[] = []
  await expect
    .poll(async () => {
      identities = await terminalIdentities(page)
      return identities.length
    })
    .toBe(count)
  return identities
}

async function exactCanvasPaneKey(page: Page, unifiedTabId: string): Promise<string> {
  const surface = page.locator(
    `[data-maestro-workspace-tab-id="${unifiedTabId}"][data-maestro-terminal-pane-key]`
  )
  await expect(surface).toHaveCount(1, { timeout: 30_000 })
  const paneKey = await surface.getAttribute('data-maestro-terminal-pane-key')
  if (!paneKey) {
    throw new Error(`Canvas pane identity is unavailable for ${unifiedTabId}`)
  }
  return paneKey
}

async function exactCanvasSurfaceKey(page: Page, unifiedTabId: string): Promise<string> {
  const surface = page.locator(`[data-maestro-workspace-tab-id="${unifiedTabId}"]`)
  await expect(surface).toHaveCount(1, { timeout: 30_000 })
  const surfaceKey = await surface.getAttribute('data-maestro-workspace-surface')
  if (!surfaceKey) {
    throw new Error(`Canvas surface identity is unavailable for ${unifiedTabId}`)
  }
  return surfaceKey
}

async function addWorker(
  page: Page,
  root: TerminalIdentity,
  displayName: string,
  index: number,
  parent: TerminalIdentity = root
): Promise<{ identity: TerminalIdentity; context: OrchestrationContext }> {
  const before = await terminalIdentities(page)
  const known = new Set(before.map((identity) => identity.unifiedTabId))
  await createCanvasResource(page, 'terminal')
  const identities = await waitForTerminalCount(page, before.length + 1)
  const identity = identities.find((candidate) => !known.has(candidate.unifiedTabId))
  if (!identity) {
    throw new Error(`The ${displayName} terminal identity was not found`)
  }
  await expect(page.locator('[data-maestro-workspace-surface]')).toHaveCount(before.length + 1, {
    timeout: 30_000
  })
  const exactPaneKey = await exactCanvasPaneKey(page, identity.unifiedTabId)
  const exactIdentity = { ...identity, paneKey: exactPaneKey }
  const context = {
    taskId: `task-${index}`,
    dispatchId: `dispatch-${index}`,
    displayName,
    parentPaneKey: parent.paneKey,
    coordinatorHandle: root.ptyId
  }
  await page.evaluate(
    ({ paneKey, orchestration }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      store.setState((state) => ({
        runtimeAgentOrchestrationByPaneKey: {
          ...state.runtimeAgentOrchestrationByPaneKey,
          [paneKey]: orchestration
        }
      }))
    },
    { paneKey: exactPaneKey, orchestration: context }
  )
  return { identity: exactIdentity, context }
}

async function writeTerminalMarkers(
  page: Page,
  terminals: readonly { identity: TerminalIdentity; label: string }[]
): Promise<void> {
  await page.evaluate(
    (items) => {
      for (const item of items) {
        const command = `printf '\\033[2J\\033[HMAESTRO ${item.label}\\nrole: ${item.label}\\nstatus: active\\n'`
        window.api.pty.write(item.ptyId, `${command}\r`)
      }
    },
    terminals.map(({ identity, label }) => ({ ptyId: identity.ptyId, label }))
  )
}

async function setOrchestrationContexts(
  page: Page,
  orchestration: Readonly<Record<string, OrchestrationContext>>
): Promise<void> {
  await page.evaluate((contexts) => {
    window.__store?.setState({ runtimeAgentOrchestrationByPaneKey: contexts })
  }, orchestration)
}

async function showAllLiveTerminals(page: Page, count: number): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if ((await page.locator('[data-terminal-preview-mode="passive"]').count()) === count) {
      return
    }
    await page.getByLabel('Zoom in').click()
    await page.waitForTimeout(240)
  }
  await expect(page.locator('[data-terminal-preview-mode="passive"]')).toHaveCount(count)
}

async function installLongTaskObserver(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const performanceWindow = window as Window & {
      __mtpLongTasks?: { duration: number; startTime: number }[]
      __mtpPerformancePhases?: { name: string; startTime: number }[]
      __mtpLongTaskObserver?: PerformanceObserver
      __mtpInteractionSamples?: { type: string; processingMs: number }[]
      __mtpInteractionCleanup?: () => void
    }
    performanceWindow.__mtpLongTasks = []
    performanceWindow.__mtpPerformancePhases = []
    performanceWindow.__mtpInteractionSamples = []
    const canvas = document.querySelector('[data-maestro-workspace-canvas]')
    const observeInteraction = (event: Event): void => {
      const startedAt = performance.now()
      queueMicrotask(() => {
        performanceWindow.__mtpInteractionSamples?.push({
          type: event.type,
          processingMs: performance.now() - startedAt
        })
      })
    }
    const interactionTypes = ['pointerdown', 'pointermove', 'pointerup', 'wheel'] as const
    for (const type of interactionTypes) {
      canvas?.addEventListener(type, observeInteraction, true)
    }
    performanceWindow.__mtpInteractionCleanup = () => {
      for (const type of interactionTypes) {
        canvas?.removeEventListener(type, observeInteraction, true)
      }
    }
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      return false
    }
    performanceWindow.__mtpLongTaskObserver = new PerformanceObserver((list) => {
      performanceWindow.__mtpLongTasks?.push(
        ...list.getEntries().map((entry) => ({
          duration: entry.duration,
          startTime: entry.startTime
        }))
      )
    })
    performanceWindow.__mtpLongTaskObserver.observe({ entryTypes: ['longtask'] })
    return true
  })
}

async function markPerformancePhase(page: Page, name: string): Promise<void> {
  await page.evaluate((phaseName) => {
    const performanceWindow = window as Window & {
      __mtpPerformancePhases?: { name: string; startTime: number }[]
    }
    performanceWindow.__mtpPerformancePhases?.push({
      name: phaseName,
      startTime: performance.now()
    })
  }, name)
}

async function exerciseFiveLiveTerminals(
  page: Page,
  identities: readonly TerminalIdentity[]
): Promise<void> {
  await markPerformancePhase(page, 'output')
  await page.evaluate((items) => {
    for (const [index, item] of items.entries()) {
      window.api.pty.write(
        item.ptyId,
        `for i in $(seq 1 32); do printf 'stream-${index}-%02d\\n' "$i"; sleep 0.02; done\r`
      )
    }
  }, identities)
  for (const [index, identity] of identities.entries()) {
    await expect(
      page.locator(`[data-terminal-preview-pty-id="${identity.ptyId}"] .xterm-screen`)
    ).toContainText(`stream-${index}-32`, { timeout: 30_000 })
  }
  await page.waitForTimeout(240)
  await markPerformancePhase(page, 'output-settled')
  const worker = page.locator('[data-maestro-workspace-content-type="terminal"]').first()
  const header = worker.locator('header')
  const headerBox = await header.boundingBox()
  if (!headerBox) {
    throw new Error('Worker header geometry is unavailable')
  }
  await markPerformancePhase(page, 'drag')
  await page.mouse.move(headerBox.x + 120, headerBox.y + headerBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(headerBox.x + 190, headerBox.y + 52, { steps: 8 })
  await page.mouse.up()
  const resize = worker.getByRole('button', { name: /^Resize / })
  const resizeBox = await resize.boundingBox()
  if (!resizeBox) {
    throw new Error('Worker resize geometry is unavailable')
  }
  await markPerformancePhase(page, 'resize')
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(resizeBox.x + 64, resizeBox.y + 44, { steps: 8 })
  await page.mouse.up()
  const background = page.locator(
    '[data-maestro-workspace-canvas] [data-slot="context-menu-trigger"]'
  )
  await markPerformancePhase(page, 'wheel')
  await background.dispatchEvent('wheel', { deltaY: -180 })
  await background.dispatchEvent('wheel', { deltaY: 160, shiftKey: true })
  await markPerformancePhase(page, 'settle')
  await page.waitForTimeout(1_200)
}

async function installPresenceTimerHarness(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harnessWindow = window as Window & {
      __mtpPresenceTimers?: Map<number, { delay: number; callback: () => void }>
      __mtpPresenceTimerSequence?: number
      __mtpOriginalSetTimeout?: typeof window.setTimeout
      __mtpOriginalClearTimeout?: typeof window.clearTimeout
    }
    const originalSetTimeout = window.setTimeout.bind(window)
    const originalClearTimeout = window.clearTimeout.bind(window)
    const timers = new Map<number, { delay: number; callback: () => void }>()
    harnessWindow.__mtpPresenceTimers = timers
    harnessWindow.__mtpPresenceTimerSequence = 1_500_000_000
    harnessWindow.__mtpOriginalSetTimeout = window.setTimeout
    harnessWindow.__mtpOriginalClearTimeout = window.clearTimeout
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if ((delay === 210 || delay === 260) && typeof handler === 'function') {
        const id = harnessWindow.__mtpPresenceTimerSequence!++
        timers.set(id, { delay, callback: () => handler(...args) })
        return id
      }
      return originalSetTimeout(handler, delay, ...args)
    }) as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined && timers.delete(id)) {
        return
      }
      originalClearTimeout(id)
    }) as typeof window.clearTimeout
  })
}

async function releasePresenceTimers(page: Page, delay: 210 | 260): Promise<void> {
  await page.evaluate((targetDelay) => {
    const harnessWindow = window as Window & {
      __mtpPresenceTimers?: Map<number, { delay: number; callback: () => void }>
    }
    for (const [id, timer] of harnessWindow.__mtpPresenceTimers ?? []) {
      if (timer.delay !== targetDelay) {
        continue
      }
      harnessWindow.__mtpPresenceTimers?.delete(id)
      timer.callback()
    }
  }, delay)
}

async function restorePresenceTimers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harnessWindow = window as Window & {
      __mtpPresenceTimers?: Map<number, { delay: number; callback: () => void }>
      __mtpOriginalSetTimeout?: typeof window.setTimeout
      __mtpOriginalClearTimeout?: typeof window.clearTimeout
    }
    if (harnessWindow.__mtpOriginalSetTimeout) {
      window.setTimeout = harnessWindow.__mtpOriginalSetTimeout
    }
    if (harnessWindow.__mtpOriginalClearTimeout) {
      window.clearTimeout = harnessWindow.__mtpOriginalClearTimeout
    }
    harnessWindow.__mtpPresenceTimers?.clear()
  })
}

async function newestSurface(page: Page, knownKeys: readonly (string | null)[]): Promise<Locator> {
  const surfaces = page.locator('[data-maestro-workspace-surface]')
  let index = -1
  await expect
    .poll(async () => {
      index = await surfaces.evaluateAll((nodes, keys) => {
        const known = new Set(keys)
        return nodes.findIndex(
          (node) => !known.has(node.getAttribute('data-maestro-workspace-surface'))
        )
      }, knownKeys)
      return index
    })
    .toBeGreaterThanOrEqual(0)
  const tabId = await surfaces.nth(index).getAttribute('data-maestro-workspace-tab-id')
  if (!tabId) {
    throw new Error('The newest Canvas surface has no exact tab identity')
  }
  return page.locator(`[data-maestro-workspace-tab-id="${tabId}"]`)
}

test.describe('Maestro Canvas agent topology and performance', () => {
  test('@mtp-evidence renders truthful topology and bounded live performance', async ({
    orcaPage
  }) => {
    test.setTimeout(600_000)
    prepareEvidence()
    const evidenceFiles: string[] = []
    await orcaPage.setViewportSize(PROFILES.notebook)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await openMaestro(orcaPage, true)
    await removeWorkspaceResources(orcaPage)

    await createCanvasResource(orcaPage, 'terminal')
    await expect(orcaPage.locator('[data-maestro-workspace-surface]')).toHaveCount(1, {
      timeout: 30_000
    })
    const discoveredRoot = (await waitForTerminalCount(orcaPage, 1))[0]!
    const root = {
      ...discoveredRoot,
      paneKey: await exactCanvasPaneKey(orcaPage, discoveredRoot.unifiedTabId)
    }
    await writeTerminalMarkers(orcaPage, [{ identity: root, label: 'ORCHESTRATOR' }])
    await expect(orcaPage.locator('[data-terminal-preview-mode="passive"]')).toHaveCount(1)
    const singleHeavyPreviewCount = await orcaPage
      .locator('[data-terminal-preview-mode="passive"]')
      .count()

    const workerLabels = ['IMPLEMENTATION', 'VERIFICATION', 'DOCUMENTATION', 'PERFORMANCE']
    const workers: { identity: TerminalIdentity; context: OrchestrationContext }[] = []
    for (const [index, displayName] of workerLabels.entries()) {
      const parent = index === 2 ? workers[0]?.identity : root
      workers.push(await addWorker(orcaPage, root, displayName, index + 1, parent))
    }
    const identities = [root, ...workers.map((worker) => worker.identity)]
    const orchestrationByPaneKey = Object.fromEntries(
      workers.map((worker) => [worker.identity.paneKey, worker.context])
    )
    await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
    await writeTerminalMarkers(orcaPage, [
      { identity: root, label: 'ORCHESTRATOR' },
      ...workers.map((worker, index) => ({
        identity: worker.identity,
        label: workerLabels[index]!
      }))
    ])
    const orchestrationDebug = await orcaPage.evaluate(() => ({
      storedPaneKeys: Object.keys(
        window.__store?.getState().runtimeAgentOrchestrationByPaneKey ?? {}
      ).sort(),
      canvasPaneKeys: [...document.querySelectorAll('[data-maestro-terminal-pane-key]')]
        .map((node) => node.getAttribute('data-maestro-terminal-pane-key'))
        .filter((value): value is string => Boolean(value))
        .sort()
    }))
    expect(orchestrationDebug.storedPaneKeys).toEqual(
      workers.map((worker) => worker.identity.paneKey).sort()
    )
    expect(orchestrationDebug.canvasPaneKeys).toEqual(
      identities.map((identity) => identity.paneKey).sort()
    )
    await expect(orcaPage.locator('[data-maestro-agent-role="coordinator"]')).toHaveCount(1)
    await expect(orcaPage.locator('[data-maestro-agent-role="worker"]')).toHaveCount(4)
    await expect(orcaPage.locator('[data-link-kind="delegates"]')).toHaveCount(4)
    await expect(orcaPage.locator('[data-link-kind="coordinates"]')).toHaveCount(1)
    const nestedSource = await exactCanvasSurfaceKey(orcaPage, workers[0]!.identity.unifiedTabId)
    const nestedTarget = await exactCanvasSurfaceKey(orcaPage, workers[2]!.identity.unifiedTabId)
    const delegateEndpoints = await orcaPage
      .locator('[data-link-kind="delegates"]')
      .evaluateAll((links) =>
        links.map((link) => [
          link.getAttribute('data-link-source'),
          link.getAttribute('data-link-target')
        ])
      )
    expect(delegateEndpoints).toContainEqual([nestedSource, nestedTarget])
    const visibleLinkLengths = await orcaPage
      .locator('[data-link-kind="delegates"] path')
      .evaluateAll((paths) => paths.map((path) => (path as SVGPathElement).getTotalLength()))
    expect(visibleLinkLengths.every((length) => length > 40)).toBe(true)
    await fitCanvas(orcaPage)
    await setTheme(orcaPage, 'dark')
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      await orcaPage.setViewportSize(profile)
      await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
      await expect(orcaPage.locator('[data-maestro-agent-role="coordinator"]')).toHaveCount(1)
      await fitCanvas(orcaPage)
      await orcaPage
        .locator('[data-maestro-agent-role="coordinator"]')
        .evaluate((element) => (element as HTMLElement).focus())
      evidenceFiles.push(await capture(orcaPage, 'mtp-topology', profile))
    }
    await setTheme(orcaPage, 'light')
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      await orcaPage.setViewportSize(profile)
      await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
      await expect(orcaPage.locator('[data-maestro-agent-role="coordinator"]')).toHaveCount(1)
      await fitCanvas(orcaPage)
      evidenceFiles.push(await capture(orcaPage, 'mtp-native-lineage', profile))
    }

    await orcaPage.setViewportSize(PROFILES.desktop)
    await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
    await fitCanvas(orcaPage)
    await showAllLiveTerminals(orcaPage, identities.length)
    const longTaskSupported = await installLongTaskObserver(orcaPage)
    await exerciseFiveLiveTerminals(orcaPage, identities)
    await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
    await expect(orcaPage.locator('[data-maestro-agent-role="coordinator"]')).toHaveCount(1)
    await expect.poll(() => activeWorkspaceTabContentType(orcaPage)).toBe('maestro')
    const passivePtyIds = await orcaPage
      .locator('[data-terminal-preview-mode="passive"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-terminal-preview-pty-id'))
      )
    const fiveHeavyPreviewCount = passivePtyIds.length
    expect(new Set(passivePtyIds).size).toBe(passivePtyIds.length)
    expect(await orcaPage.evaluate(() => Boolean(document.activeElement?.closest('.xterm')))).toBe(
      false
    )
    const performanceMetrics = await orcaPage.evaluate(() => {
      const performanceWindow = window as Window & {
        __mtpLongTasks?: { duration: number; startTime: number }[]
        __mtpPerformancePhases?: { name: string; startTime: number }[]
        __mtpLongTaskObserver?: PerformanceObserver
        __mtpInteractionSamples?: { type: string; processingMs: number }[]
        __mtpInteractionCleanup?: () => void
      }
      performanceWindow.__mtpLongTaskObserver?.disconnect()
      performanceWindow.__mtpInteractionCleanup?.()
      const longTasks = performanceWindow.__mtpLongTasks ?? []
      const phases = performanceWindow.__mtpPerformancePhases ?? []
      return {
        longTasksMs: longTasks.map((task) => task.duration),
        longTasks: longTasks.map((task) => ({
          ...task,
          phase: phases.findLast((phase) => phase.startTime <= task.startTime)?.name ?? 'unknown'
        })),
        interactionSamples: performanceWindow.__mtpInteractionSamples ?? [],
        activeElementInsideTerminal: Boolean(document.activeElement?.closest('.xterm'))
      }
    })
    writeMetrics({
      longTaskSupported,
      ...performanceMetrics,
      singleHeavyPreviewCount,
      fiveHeavyPreviewCount,
      passivePtyIds
    })
    expect(
      Math.max(0, ...performanceMetrics.interactionSamples.map((sample) => sample.processingMs))
    ).toBeLessThan(50)
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      await orcaPage.setViewportSize(profile)
      await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
      await fitCanvas(orcaPage)
      await showAllLiveTerminals(orcaPage, identities.length)
      evidenceFiles.push(await capture(orcaPage, 'mtp-five-live', profile))
    }

    await setOrchestrationContexts(orcaPage, {})
    await expect(orcaPage.locator('[data-maestro-agent-role]')).toHaveCount(0)
    await expect(orcaPage.locator('[data-link-provenance="runtime-lineage"]')).toHaveCount(0)
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-no-orchestration', profile))
    }
    await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
    await expect(orcaPage.locator('[data-maestro-agent-role="coordinator"]')).toHaveCount(1)

    await setTheme(orcaPage, 'dark')
    await setOrchestrationContexts(orcaPage, orchestrationByPaneKey)
    await fitCanvas(orcaPage)
    await installPresenceTimerHarness(orcaPage)
    const keysBeforeSmoke = await orcaPage
      .locator('[data-maestro-workspace-surface]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-maestro-workspace-surface'))
      )
    await createCanvasResource(orcaPage, 'annotation')
    const smokeSurface = await newestSurface(orcaPage, keysBeforeSmoke)
    await expect(smokeSurface).toHaveAttribute('data-maestro-presence', 'entering')
    await smokeSurface.evaluate((node) => {
      for (const animation of node.getAnimations({ subtree: true })) {
        animation.pause()
        animation.currentTime = 0
      }
    })
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-smoke-enter-start', profile, 'allow'))
    }
    await smokeSurface.evaluate((node) => {
      for (const animation of node.getAnimations({ subtree: true })) {
        animation.currentTime = 130
      }
    })
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-smoke-enter-middle', profile, 'allow'))
    }
    await releasePresenceTimers(orcaPage, 260)
    await expect(smokeSurface).toHaveAttribute('data-maestro-presence', 'present')
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-smoke-settled', profile))
    }
    await smokeSurface.getByRole('button', { name: 'Close exact tab' }).click()
    await expect(smokeSurface).toHaveAttribute('data-maestro-presence', 'exiting')
    await smokeSurface.evaluate((node) => {
      for (const animation of node.getAnimations({ subtree: true })) {
        animation.pause()
        animation.currentTime = 105
      }
    })
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-smoke-exit-middle', profile, 'allow'))
    }
    await releasePresenceTimers(orcaPage, 210)
    await expect(smokeSurface).toHaveCount(0)
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-smoke-removed', profile))
    }

    await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
    const keysBeforeReduced = await orcaPage
      .locator('[data-maestro-workspace-surface]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-maestro-workspace-surface'))
      )
    await createCanvasResource(orcaPage, 'annotation')
    const reducedSurface = await newestSurface(orcaPage, keysBeforeReduced)
    await expect(reducedSurface).toHaveAttribute('data-maestro-presence', 'entering')
    await expect
      .poll(() =>
        reducedSurface
          .locator('.maestro-workspace-smoke')
          .evaluate((node) => getComputedStyle(node).display)
      )
      .toBe('none')
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-reduced-motion', profile, 'allow'))
    }
    await releasePresenceTimers(orcaPage, 260)
    await reducedSurface.getByRole('button', { name: 'Close exact tab' }).click()
    await expect(reducedSurface).toHaveAttribute('data-maestro-presence', 'exiting')
    await releasePresenceTimers(orcaPage, 210)
    await expect(reducedSurface).toHaveCount(0)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    await restorePresenceTimers(orcaPage)

    await createCanvasResource(orcaPage, 'browser')
    await expect(orcaPage.locator('[data-maestro-workspace-surface]')).toHaveCount(6, {
      timeout: 30_000
    })
    for (let index = 0; index < 6; index += 1) {
      const before = await orcaPage.locator('[data-maestro-workspace-surface]').count()
      await createCanvasResource(orcaPage, 'annotation')
      await expect(orcaPage.locator('[data-maestro-workspace-surface]')).toHaveCount(before + 1, {
        timeout: 30_000
      })
    }
    await expect(orcaPage.locator('[data-maestro-workspace-surface]')).toHaveCount(12)
    await fitCanvas(orcaPage)
    for (let index = 0; index < 6; index += 1) {
      await orcaPage.getByLabel('Zoom out').click()
    }
    await expect
      .poll(() => orcaPage.locator('[data-maestro-preview-placeholder]').count())
      .toBeGreaterThan(0)
    for (const profile of [PROFILES.desktop, PROFILES.notebook]) {
      evidenceFiles.push(await capture(orcaPage, 'mtp-lod-overview', profile))
    }
    const overviewHeavyPreviewCount = await orcaPage
      .locator('[data-terminal-preview-mode="passive"]')
      .count()
    writeMetrics({
      longTaskSupported,
      ...performanceMetrics,
      singleHeavyPreviewCount,
      fiveHeavyPreviewCount,
      overviewHeavyPreviewCount,
      passivePtyIds,
      totalSurfaceCount: 12
    })
    writeManifest({
      files: evidenceFiles,
      metrics: {
        platform: 'linux-electron',
        profiles: [PROFILES.desktop, PROFILES.notebook],
        longTaskSupported,
        ...performanceMetrics,
        singleHeavyPreviewCount,
        fiveHeavyPreviewCount,
        overviewHeavyPreviewCount,
        passivePtyIds,
        totalSurfaceCount: 12
      }
    })
  })
})
