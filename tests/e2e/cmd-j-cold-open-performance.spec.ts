import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { PALETTE_INTERACTION_BUDGET } from '../../src/renderer/src/lib/palette-match/palette-match-budget'
import { PALETTE_SECTION_RENDER_CAP } from '../../src/renderer/src/components/cmd-j/palette-section-render-cap'

const WORKSPACE_COUNT = 800
const {
  rendererStoreDispatchMs: MAX_STORE_DISPATCH_MS,
  firstVisibleResultsMs: MAX_FIRST_VISIBLE_MS,
  coldIndexReadyMs: MAX_COLD_INDEX_READY_MS,
  coldImmediateQueryResultsMs: MAX_COLD_IMMEDIATE_QUERY_MS,
  maxFrameGapMs: MAX_FRAME_GAP_MS
} = PALETTE_INTERACTION_BUDGET
const TARGET_QUERY = 'needle 0399'
const TARGET_LOCAL_NAME = 'Needle local 0399'
const TARGET_REMOTE_NAME = 'Needle remote 0399'
const RESULTS_SETTLING_WINDOW_MS = 250

type InteractionMetrics = {
  firstVisibleMs: number
  indexReadyMs: number
  storeDispatchMs: number | null
  maxFrameGapMs: number
  maxFrameGapStartedMs: number
  longTasks: { durationMs: number; startedMs: number }[]
  sampledMs: number
  visibleTexts: string[]
}

type CmdJPerformanceProbe = {
  begin: (expectedTexts: string[]) => void
  finish: () => InteractionMetrics | null
  stop: () => void
}

type PerformanceProbeWindow = Window & { __cmdJPerformanceProbe?: CmdJPerformanceProbe }

type PendingFeedbackProof = {
  sawLoading: boolean
  sawNoResults: boolean
  sawPending: boolean
  sawZeroResults: boolean
}

type PendingFeedbackWindow = Window & {
  __cmdJPendingFeedbackObserver?: MutationObserver
  __cmdJPendingFeedbackProof?: PendingFeedbackProof
}

async function seedAccumulatedWorkspaceCatalog(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspaceCount, targetLocalName, targetRemoteName }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const now = Date.now()
      const sharedRepoId = 'perf-repo'
      const localRepo = {
        id: sharedRepoId,
        path: '/perf/orca',
        displayName: 'acme/orca-local',
        badgeColor: '#64748b',
        addedAt: now,
        kind: 'git' as const,
        executionHostId: 'local' as const
      }
      const remoteRepo = {
        ...localRepo,
        path: '/srv/perf/orca',
        displayName: 'acme/orca-remote',
        connectionId: 'perf-box',
        executionHostId: 'ssh:perf-box' as const
      }
      const longComment =
        'Blocked on the staging relay while the execution host reconnects; review the rollback runbook and deployment evidence before retrying. '.repeat(
          6
        )
      const worktrees = Array.from({ length: workspaceCount }, (_, index) => {
        const pairIndex = Math.floor(index / 2)
        const suffix = String(pairIndex).padStart(4, '0')
        const remote = index % 2 === 1
        const hostId = remote ? ('ssh:perf-box' as const) : ('local' as const)
        const displayName =
          pairIndex === 399
            ? remote
              ? targetRemoteName
              : targetLocalName
            : `Accumulated ${remote ? 'remote' : 'local'} workspace ${suffix}`
        return {
          id: `${sharedRepoId}::/perf/workspace-${suffix}`,
          instanceId: `perf-instance-${index}`,
          repoId: sharedRepoId,
          projectId: 'perf-project',
          hostId,
          projectHostSetupId: remote ? 'perf-ssh-setup' : 'perf-local-setup',
          path: remote ? `/srv/perf/workspace-${suffix}` : `/perf/workspace-${suffix}`,
          head: index.toString(16).padStart(40, 'a'),
          branch: `refs/heads/perf/accumulated-${suffix}-${remote ? 'remote' : 'local'}`,
          isBare: false,
          isMainWorktree: pairIndex === 0,
          displayName,
          comment: `${longComment} Dataset row ${index}.`,
          linkedIssue: 10_000 + index,
          linkedPR: 20_000 + index,
          linkedLinearIssue: `STA-${30_000 + index}`,
          linkedWorkItem: {
            provider: index % 4 === 0 ? ('gitlab' as const) : ('linear' as const),
            type: index % 4 === 0 ? ('mr' as const) : ('issue' as const),
            number: 30_000 + index,
            title: `Rework the palette ranking pipeline for accumulated workspace ${index}`,
            url:
              index % 4 === 0
                ? `https://gitlab.example/acme/orca/-/merge_requests/${30_000 + index}`
                : `https://linear.app/acme/issue/STA-${30_000 + index}`,
            linearIdentifier: index % 4 === 0 ? undefined : `STA-${30_000 + index}`
          },
          automationProvenance: {
            kind: 'created-by-automation' as const,
            automationId: `perf-auto-${index % 8}`,
            automationNameSnapshot: 'Nightly accumulated workspace review',
            automationRunId: `perf-run-${index}`,
            automationRunTitleSnapshot: `Scan daily sweep ${index}`,
            createdAt: now - index * 60_000,
            executionTargetType: remote ? ('ssh' as const) : ('local' as const),
            executionTargetId: remote ? 'perf-box' : sharedRepoId,
            projectId: 'perf-project',
            repoId: sharedRepoId,
            hostId
          },
          isArchived: false,
          isUnread: index % 7 === 0,
          isPinned: index % 19 === 0,
          sortOrder: index,
          lastActivityAt: now - (workspaceCount - index) * 1_000
        }
      })
      const ports = worktrees.map((worktree, index) => ({
        id: `perf-port-${index}`,
        bindHost: '127.0.0.1',
        connectHost: '127.0.0.1',
        port: 3_000 + index,
        pid: 40_000 + index,
        processName: index % 2 === 0 ? 'node' : 'vite',
        protocol: 'http' as const,
        kind: 'workspace' as const,
        owner: {
          worktreeId: worktree.id,
          repoId: worktree.repoId,
          displayName: worktree.displayName,
          path: worktree.path,
          confidence: 'cwd' as const
        }
      }))

      // Keep the valid fixture workspace active so failed providers/watchers do not pollute the oracle.
      store.setState({
        repos: [...state.repos, localRepo, remoteRepo],
        worktreesByRepo: { ...state.worktreesByRepo, [sharedRepoId]: worktrees },
        workspacePortScan: {
          key: 'perf-800-workspaces',
          result: { platform: 'darwin', scannedAt: now, ports }
        },
        showSleepingWorkspaces: true,
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        activeView: 'tasks',
        sidebarOpen: false,
        rightSidebarOpen: false,
        activeModal: undefined
      })
    },
    {
      workspaceCount: WORKSPACE_COUNT,
      targetLocalName: TARGET_LOCAL_NAME,
      targetRemoteName: TARGET_REMOTE_NAME
    }
  )
}

async function installPendingFeedbackObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-worktree-search-pending]')
    if (!list) {
      throw new Error('Cmd-J result list is not available')
    }
    const proof: PendingFeedbackProof = {
      sawLoading: false,
      sawNoResults: false,
      sawPending: false,
      sawZeroResults: false
    }
    const sample = (): void => {
      if (list.dataset.worktreeSearchPending !== 'true') {
        return
      }
      proof.sawPending = true
      proof.sawLoading ||= list.textContent?.includes('Loading jump targets') === true
      proof.sawNoResults ||= list.textContent?.includes('No results match your search') === true
      proof.sawZeroResults ||=
        list.closest('[role="dialog"]')?.textContent?.includes('0 results found') === true
    }
    const observer = new MutationObserver(sample)
    observer.observe(list, {
      attributes: true,
      childList: true,
      subtree: true
    })
    const pendingWindow = window as PendingFeedbackWindow
    pendingWindow.__cmdJPendingFeedbackObserver = observer
    pendingWindow.__cmdJPendingFeedbackProof = proof
    sample()
  })
}

async function installPerformanceProbe(page: Page): Promise<void> {
  await page.evaluate((settlingWindowMs) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    let actionStartedAt = 0
    let expectedTexts: string[] = []
    let resultsStableAt: number | null = null
    let firstVisibleAt: number | null = null
    let indexReadyAt: number | null = null
    let completedMetrics: InteractionMetrics | null = null
    let storeDispatchMs: number | null = null
    let maxFrameGapMs = 0
    let maxFrameGapStartedAt = 0
    let previousFrameAt = performance.now()
    let longTasks: { durationMs: number; startedAt: number }[] = []
    let visibleTexts: string[] = []
    let frameId = 0
    const originalOpenModal = store.getState().openModal

    store.setState({
      openModal: (...args: Parameters<typeof originalOpenModal>) => {
        const startedAt = performance.now()
        originalOpenModal(...args)
        if (args[0] === 'worktree-palette') {
          storeDispatchMs = performance.now() - startedAt
        }
      }
    })

    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ durationMs: entry.duration, startedAt: entry.startTime })
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })

    const sampleFrame = (): void => {
      const now = performance.now()
      if (actionStartedAt > 0 && completedMetrics === null) {
        const frameGapMs = now - previousFrameAt
        if (frameGapMs > maxFrameGapMs) {
          maxFrameGapMs = frameGapMs
          maxFrameGapStartedAt = previousFrameAt
        }
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            '[role="dialog"][data-state="open"] [cmdk-item]'
          )
        ]
        visibleTexts = items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        const hasExpectedRows =
          items.length > 0 &&
          expectedTexts.every((expected) => visibleTexts.some((text) => text.includes(expected)))
        const indexMarker = document.querySelector<HTMLElement>('[data-worktree-index-pending]')
        const indexReady = indexMarker?.dataset.worktreeIndexPending === 'false'
        if (hasExpectedRows && indexReady) {
          indexReadyAt ??= now
        }
        if (hasExpectedRows) {
          firstVisibleAt ??= now
        }
        resultsStableAt = hasExpectedRows && indexReady ? (resultsStableAt ?? now) : null
        if (
          firstVisibleAt !== null &&
          resultsStableAt !== null &&
          now - resultsStableAt >= settlingWindowMs
        ) {
          completedMetrics = {
            firstVisibleMs: firstVisibleAt - actionStartedAt,
            indexReadyMs: (indexReadyAt ?? now) - actionStartedAt,
            storeDispatchMs,
            maxFrameGapMs,
            maxFrameGapStartedMs: maxFrameGapStartedAt - actionStartedAt,
            longTasks: longTasks
              .filter((task) => task.startedAt + task.durationMs >= actionStartedAt)
              .map((task) => ({
                durationMs: task.durationMs,
                startedMs: task.startedAt - actionStartedAt
              })),
            sampledMs: now - actionStartedAt,
            visibleTexts
          }
        }
      }
      previousFrameAt = now
      frameId = requestAnimationFrame(sampleFrame)
    }
    frameId = requestAnimationFrame(sampleFrame)

    ;(window as PerformanceProbeWindow).__cmdJPerformanceProbe = {
      begin: (nextExpectedTexts) => {
        actionStartedAt = performance.now()
        previousFrameAt = actionStartedAt
        expectedTexts = nextExpectedTexts
        resultsStableAt = null
        firstVisibleAt = null
        indexReadyAt = null
        completedMetrics = null
        maxFrameGapMs = 0
        maxFrameGapStartedAt = 0
        longTasks = []
        visibleTexts = []
      },
      finish: () => completedMetrics,
      stop: () => {
        cancelAnimationFrame(frameId)
        longTaskObserver.disconnect()
        store.setState({ openModal: originalOpenModal })
      }
    }
  }, RESULTS_SETTLING_WINDOW_MS)
}

async function beginProbe(page: Page, expectedTexts: string[]): Promise<void> {
  await page.evaluate(
    (texts) => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.begin(texts),
    expectedTexts
  )
}

async function readMetrics(page: Page): Promise<InteractionMetrics | null> {
  return page.evaluate(
    () => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.finish() ?? null
  )
}

async function togglePaletteFromMain(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    if (!mainWindow) {
      throw new Error('Orca main window is not available')
    }
    mainWindow.webContents.send('ui:toggleWorktreePalette')
  })
}

async function waitForStableFrameCadence(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        let previousFrameAt = performance.now()
        let stableFrames = 0
        let frameId = 0
        const timeoutId = window.setTimeout(() => {
          cancelAnimationFrame(frameId)
          reject(new Error('Cmd-J frame cadence did not stabilize within 10 seconds'))
        }, 10_000)
        const sample = (): void => {
          const now = performance.now()
          stableFrames = now - previousFrameAt <= 25 ? stableFrames + 1 : 0
          previousFrameAt = now
          if (stableFrames >= 12) {
            window.clearTimeout(timeoutId)
            resolve()
            return
          }
          frameId = requestAnimationFrame(sample)
        }
        frameId = requestAnimationFrame(sample)
      })
  )
}

async function expectHostQualifiedNeedleOrder(dialog: Locator): Promise<void> {
  const matchingRows = dialog
    .locator('[cmdk-item]:has([data-slot="palette-worktree-name"])')
    .filter({ hasText: 'Needle' })
  await expect(matchingRows).toHaveCount(2)
  const matchingTexts = (await matchingRows.allTextContents()).map((text) =>
    text.replace(/\s+/g, ' ').trim()
  )
  expect(matchingTexts[0]).toContain(TARGET_REMOTE_NAME)
  expect(matchingTexts[0]).toContain('acme/orca-remote')
  expect(matchingTexts[1]).toContain(TARGET_LOCAL_NAME)
  expect(matchingTexts[1]).toContain('acme/orca-local')
}

async function expectHostSpecificNeedle(
  dialog: Locator,
  query: string,
  expectedName: string,
  expectedRepo: string
): Promise<void> {
  await dialog.getByPlaceholder(/Search chats, terminals, worktrees/).fill(query)
  const matchingRows = dialog
    .locator('[cmdk-item]:has([data-slot="palette-worktree-name"])')
    .filter({ hasText: 'Needle' })
  await expect(matchingRows).toHaveCount(1)
  await expect(matchingRows).toContainText(expectedName)
  await expect(matchingRows).toContainText(expectedRepo)
}

async function expectAccumulatedCatalogCompleteness(dialog: Locator): Promise<void> {
  const input = dialog.getByPlaceholder(/Search chats, terminals, worktrees/)
  await input.fill('accumulated')
  const rows = dialog.locator('[cmdk-item]:has([data-slot="palette-worktree-name"])')
  await expect(rows.first()).toContainText('Accumulated')
  await expect(rows).toHaveCount(PALETTE_SECTION_RENDER_CAP)
  await expect(
    dialog.getByText(`${WORKSPACE_COUNT - PALETTE_SECTION_RENDER_CAP} more`, { exact: true })
  ).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'See more' })).toBeVisible()
  const firstOrder = await rows.allTextContents()
  expect(new Set(firstOrder).size).toBe(50)

  await input.fill('')
  await expect(rows).not.toHaveCount(PALETTE_SECTION_RENDER_CAP)
  await input.fill('accumulated')
  await expect(rows.first()).toContainText('Accumulated')
  await expect(rows).toHaveCount(PALETTE_SECTION_RENDER_CAP)
  await expect.poll(() => rows.allTextContents()).toEqual(firstOrder)
}

function expectFrameSafe(metrics: InteractionMetrics): void {
  expectPaletteBudget('max frame gap', metrics.maxFrameGapMs, MAX_FRAME_GAP_MS)
  expectPaletteBudget(
    'longest task',
    Math.max(0, ...metrics.longTasks.map((task) => task.durationMs)),
    MAX_FRAME_GAP_MS
  )
}

function expectPaletteBudget(label: string, value: number, budget: number): void {
  if (value <= budget) {
    return
  }
  // Shared Linux Xvfb runners have measurable scheduling jitter; keep the metric visible in
  // CI artifacts while the packaged local Electron proof remains the blocking budget gate.
  if (process.env.CI && process.env.ORCA_STRICT_PALETTE_PERF !== '1') {
    console.warn(`[cmd-j-cold-open] advisory budget miss: ${label}=${value}ms > ${budget}ms`)
    return
  }
  expect(value, `${label} exceeded palette budget`).toBeLessThanOrEqual(budget)
}

test.describe('Cmd-J cold accumulated-workspace performance @headful', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('paints complete host-qualified results within the frame-gap budget', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await seedAccumulatedWorkspaceCatalog(orcaPage)
    await installPerformanceProbe(orcaPage)
    await waitForStableFrameCadence(orcaPage)

    await beginProbe(orcaPage, [TARGET_REMOTE_NAME, TARGET_LOCAL_NAME])
    await togglePaletteFromMain(electronApp)
    const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const coldOpen = await readMetrics(orcaPage)
    expect(coldOpen).not.toBeNull()
    await expectHostQualifiedNeedleOrder(dialog)

    await beginProbe(orcaPage, [
      TARGET_REMOTE_NAME,
      TARGET_LOCAL_NAME,
      `Create worktree "${TARGET_QUERY}"`
    ])
    await dialog.getByPlaceholder(/Search chats, terminals, worktrees/).fill(TARGET_QUERY)
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const indexedQuery = await readMetrics(orcaPage)
    expect(indexedQuery).not.toBeNull()

    await expectHostQualifiedNeedleOrder(dialog)
    await expectHostSpecificNeedle(
      dialog,
      'accumulated-0399-remote',
      TARGET_REMOTE_NAME,
      'acme/orca-remote'
    )
    await expectHostSpecificNeedle(
      dialog,
      'accumulated-0399-local',
      TARGET_LOCAL_NAME,
      'acme/orca-local'
    )
    await expectAccumulatedCatalogCompleteness(dialog)

    await togglePaletteFromMain(electronApp)
    await expect(dialog).toHaveAttribute('data-state', 'closed')
    await beginProbe(orcaPage, [TARGET_REMOTE_NAME, TARGET_LOCAL_NAME])
    await togglePaletteFromMain(electronApp)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-worktree-index-pending]')).toHaveAttribute(
      'data-worktree-index-pending',
      'false'
    )
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const retainedReopen = await readMetrics(orcaPage)
    expect(retainedReopen).not.toBeNull()
    await expectHostQualifiedNeedleOrder(dialog)

    await togglePaletteFromMain(electronApp)
    await expect(dialog).toHaveCount(0)
    await orcaPage.waitForTimeout(350)
    await beginProbe(orcaPage, [TARGET_REMOTE_NAME, TARGET_LOCAL_NAME])
    await togglePaletteFromMain(electronApp)
    await expect(dialog).toBeVisible()
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const remountedColdReopen = await readMetrics(orcaPage)
    expect(remountedColdReopen).not.toBeNull()
    await expectHostQualifiedNeedleOrder(dialog)

    const report = {
      coldOpen,
      indexedQuery,
      retainedReopen,
      remountedColdReopen,
      workspaceCount: WORKSPACE_COUNT
    }
    await testInfo.attach('cmd-j-cold-open-metrics.json', {
      body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
      contentType: 'application/json'
    })
    await testInfo.attach('cmd-j-cold-open-visible.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    console.log(`[cmd-j-cold-open] ${JSON.stringify(report)}`)

    expect(coldOpen!.storeDispatchMs).not.toBeNull()
    expectPaletteBudget('store dispatch', coldOpen!.storeDispatchMs!, MAX_STORE_DISPATCH_MS)
    expectPaletteBudget('first visible', coldOpen!.firstVisibleMs, MAX_FIRST_VISIBLE_MS)
    expectPaletteBudget('cold index ready', coldOpen!.indexReadyMs, MAX_COLD_INDEX_READY_MS)
    expectFrameSafe(coldOpen!)
    expectPaletteBudget(
      'indexed query first visible',
      indexedQuery!.firstVisibleMs,
      MAX_FIRST_VISIBLE_MS
    )
    expectFrameSafe(indexedQuery!)
    expectPaletteBudget(
      'retained first visible',
      retainedReopen!.firstVisibleMs,
      MAX_FIRST_VISIBLE_MS
    )
    expectPaletteBudget(
      'retained index ready',
      retainedReopen!.indexReadyMs,
      MAX_COLD_INDEX_READY_MS
    )
    expectFrameSafe(retainedReopen!)
    expectPaletteBudget(
      'remounted first visible',
      remountedColdReopen!.firstVisibleMs,
      MAX_FIRST_VISIBLE_MS
    )
    expectPaletteBudget(
      'remounted index ready',
      remountedColdReopen!.indexReadyMs,
      MAX_COLD_INDEX_READY_MS
    )
    expect(remountedColdReopen!.indexReadyMs).toBeGreaterThan(remountedColdReopen!.firstVisibleMs)
    expectFrameSafe(remountedColdReopen!)

    await orcaPage.evaluate(() => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.stop())
  })

  test('keeps an immediate cold query complete and frame-safe', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await seedAccumulatedWorkspaceCatalog(orcaPage)
    await installPerformanceProbe(orcaPage)
    await waitForStableFrameCadence(orcaPage)

    await togglePaletteFromMain(electronApp)
    const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(dialog).toBeVisible()
    await installPendingFeedbackObserver(orcaPage)
    await beginProbe(orcaPage, [
      TARGET_REMOTE_NAME,
      TARGET_LOCAL_NAME,
      `Create worktree "${TARGET_QUERY}"`
    ])
    await dialog.getByPlaceholder(/Search chats, terminals, worktrees/).fill(TARGET_QUERY)
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const coldImmediateQuery = await readMetrics(orcaPage)
    expect(coldImmediateQuery).not.toBeNull()
    await expectHostQualifiedNeedleOrder(dialog)
    const pendingFeedbackProof = await orcaPage.evaluate(() => {
      const pendingWindow = window as PendingFeedbackWindow
      pendingWindow.__cmdJPendingFeedbackObserver?.disconnect()
      delete pendingWindow.__cmdJPendingFeedbackObserver
      return pendingWindow.__cmdJPendingFeedbackProof ?? null
    })
    expect(pendingFeedbackProof).toEqual({
      sawLoading: true,
      sawNoResults: false,
      sawPending: true,
      sawZeroResults: false
    })

    await testInfo.attach('cmd-j-cold-immediate-query-metrics.json', {
      body: Buffer.from(`${JSON.stringify(coldImmediateQuery, null, 2)}\n`),
      contentType: 'application/json'
    })
    console.log(`[cmd-j-cold-immediate-query] ${JSON.stringify(coldImmediateQuery)}`)

    expectPaletteBudget(
      'cold immediate query first visible',
      coldImmediateQuery!.firstVisibleMs,
      MAX_COLD_IMMEDIATE_QUERY_MS
    )
    expectFrameSafe(coldImmediateQuery!)
    await orcaPage.evaluate(() => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.stop())
  })
})
