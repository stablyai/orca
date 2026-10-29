import { expect, test } from './helpers/orca-app'
import { readHostBrowserPageIds } from './helpers/host-session-tabs'
import {
  readPanes,
  requireGroup,
  setUpPairedFixture,
  waitForGroupTabCount
} from './helpers/paired-browser-placement-fixture'

type FaultWindow = Window & {
  __webRuntimeBrowserCreationFault?: {
    arm: () => void
    armPreparation: () => void
    release: () => boolean
    releasePreparation: () => boolean
    reset: () => void
    snapshot: () => { armed: boolean; createdPageId: string | null; preparationReached: boolean }
  }
}

type CreateTimings = {
  appearedAfterMs: number | null
  appearedBeforeSettle: boolean
  settledAfterMs: number | null
  tabIdAtFirstSight: string | null
}

// Require the optimistic tab before the held create promise settles; ordering avoids a machine-dependent latency budget.
async function createAndWatch(
  fixture: Awaited<ReturnType<typeof setUpPairedFixture>>,
  groupId: string
): Promise<CreateTimings> {
  return fixture.client.page.evaluate(
    async ({ groupId, url, worktreeId }) => {
      const store = window.__store
      const state = store?.getState()
      if (!store || !state) {
        throw new Error('Paired client store unavailable')
      }
      state.setBrowserDefaultUrl(url)
      const startedAt = performance.now()
      let settledAfterMs: number | null = null
      const create = state
        .openNewBrowserTabInActiveWorkspace(groupId)
        .catch(() => undefined)
        .finally(() => {
          settledAfterMs = performance.now() - startedAt
        })

      const browserTabs = (): { id: string }[] =>
        (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).filter(
          (tab) => tab.contentType === 'browser'
        )
      let appearedAfterMs: number | null = null
      let tabIdAtFirstSight: string | null = null
      while (performance.now() - startedAt < 30_000) {
        const tabs = browserTabs()
        if (tabs.length > 0) {
          appearedAfterMs = performance.now() - startedAt
          tabIdAtFirstSight = tabs[0].id
          break
        }
        if (settledAfterMs !== null) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
      const appearedBeforeSettle = appearedAfterMs !== null && settledAfterMs === null
      await create
      return { appearedAfterMs, appearedBeforeSettle, settledAfterMs, tabIdAtFirstSight }
    },
    { groupId, url: fixture.url, worktreeId: fixture.worktreeId }
  )
}

/** Every distinct browser-tab-id list the store passed through, in order. */
async function recordBrowserTabTransitions(
  fixture: Awaited<ReturnType<typeof setUpPairedFixture>>
): Promise<void> {
  await fixture.client.page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired client store unavailable')
    }
    const transitions: string[] = []
    const record = (): void => {
      const key = (store.getState().unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tab.contentType === 'browser')
        .map((tab) => tab.id)
        .join(',')
      if (transitions.at(-1) !== key) {
        transitions.push(key)
      }
    }
    record()
    ;(window as unknown as { __browserTabTransitions: string[] }).__browserTabTransitions =
      transitions
    store.subscribe(record)
  }, fixture.worktreeId)
}

/** Worktree-scoped browser census, for a worktree whose group comes and goes with the tab. */
async function readEmptyWorktreeState(
  page: Awaited<ReturnType<typeof setUpPairedFixture>>['client']['page'],
  worktreeId: string
): Promise<{ activeWorktreeId: string | null; browserTabs: number; browserWorkspaces: number }> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    return {
      activeWorktreeId: state?.activeWorktreeId ?? null,
      browserTabs: (state?.unifiedTabsByWorktree[id] ?? []).filter(
        (tab) => tab.contentType === 'browser'
      ).length,
      browserWorkspaces: (state?.browserTabsByWorktree[id] ?? []).length
    }
  }, worktreeId)
}

async function readBrowserTabTransitions(
  fixture: Awaited<ReturnType<typeof setUpPairedFixture>>
): Promise<string[]> {
  return fixture.client.page.evaluate(
    () => (window as unknown as { __browserTabTransitions: string[] }).__browserTabTransitions ?? []
  )
}

/** What the address bar in the visible browser pane holds right now. */
async function readAddressBarState(
  page: Awaited<ReturnType<typeof setUpPairedFixture>>['client']['page']
): Promise<{ bars: number; focused: boolean; value: string | null }> {
  return page.evaluate(() => {
    const bars = document.querySelectorAll('[data-orca-browser-address-bar]')
    const input = bars[0] as HTMLInputElement | undefined
    return {
      bars: bars.length,
      focused: input !== undefined && document.activeElement === input,
      value: input?.value ?? null
    }
  })
}

async function readActiveBrowserPlacementKind(
  page: Awaited<ReturnType<typeof setUpPairedFixture>>['client']['page'],
  worktreeId: string
): Promise<string | null> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    for (const workspace of state?.browserTabsByWorktree[id] ?? []) {
      for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
        const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
        return handle?.staged === true ? 'staged' : (handle?.placement?.kind ?? 'server')
      }
    }
    return null
  }, worktreeId)
}

// Adoption replaces the pane after a host roundtrip; preserve any address the user already typed.
test('keeps an address typed into the staged tab when the paired create is adopted', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture

    await client.page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser creation E2E fault seam unavailable')
      }
      fault.arm()
    })
    await client.page.evaluate(
      ({ groupId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Paired client store unavailable')
        }
        state.setBrowserDefaultUrl(url)
        const create = state.openNewBrowserTabInActiveWorkspace(groupId).catch(() => undefined)
        ;(window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate = create
      },
      { groupId: rootGroupId, url: fixture.url }
    )

    await client.page.locator('[data-orca-browser-address-bar]').first().waitFor()
    await expect
      .poll(() => readActiveBrowserPlacementKind(client.page, worktreeId), {
        timeout: 60_000,
        message: 'paired client never staged the optimistic browser tab'
      })
      .toBe('staged')
    await expect
      .poll(
        () =>
          client.page.evaluate(
            () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
          ),
        { timeout: 60_000, message: 'held browser create never reached the fault seam' }
      )
      .toMatchObject({ armed: true, createdPageId: expect.any(String) })

    // The user types their address while the create is still held at the seam.
    const typed = 'example.internal/typed-before-adoption'
    const addressBar = client.page.locator('[data-orca-browser-address-bar]').first()
    await addressBar.click()
    await client.page.keyboard.type(typed)
    expect(await readAddressBarState(client.page)).toMatchObject({ focused: true, value: typed })

    // Reset permits successful adoption; release would arm reconciliation failure and rollback.
    await client.page.evaluate(() =>
      (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset()
    )
    await client.page.evaluate(
      () => (window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate
    )
    await expect
      .poll(() => readActiveBrowserPlacementKind(client.page, worktreeId), {
        timeout: 90_000,
        message: 'the held create never adopted its staged tab'
      })
      .toBe('client')

    // Wait through the adopted pane’s mount, which can overwrite the address a frame after handle replacement.
    await client.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2_000)))
    expect(await readAddressBarState(client.page)).toEqual({ bars: 1, focused: true, value: typed })
  } finally {
    await fixture.dispose()
  }
})

test('shows a paired browser tab before its create RPC resolves, then keeps it as one tab', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const before = requireGroup(await readPanes(client.page, worktreeId), rootGroupId)
    await recordBrowserTabTransitions(fixture)

    const timings = await createAndWatch(fixture, rootGroupId)
    testInfo.annotations.push({
      type: 'instant-tab-latency',
      description: `tab visible after ${timings.appearedAfterMs?.toFixed(1)}ms; create settled after ${timings.settledAfterMs?.toFixed(1)}ms`
    })

    expect(timings.appearedAfterMs).not.toBeNull()
    expect(timings.appearedBeforeSettle).toBe(true)
    expect(timings.settledAfterMs).not.toBeNull()
    expect(timings.appearedAfterMs!).toBeLessThan(timings.settledAfterMs!)

    const after = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rootGroupId,
      before.tabOrder.length + 1,
      'paired client lost the optimistic browser tab'
    )
    const group = requireGroup(after, rootGroupId)
    expect(group.tabOrder.slice(0, before.tabOrder.length)).toEqual(before.tabOrder)
    expect(group.tabOrder.at(-1)).toBe(timings.tabIdAtFirstSight)
    expect(group.activeTabId).toBe(timings.tabIdAtFirstSight)

    // Any empty/different-id transition reveals strip flicker during adoption.
    expect(await readBrowserTabTransitions(fixture)).toEqual(['', timings.tabIdAtFirstSight])

    // The host has to own it by now: materialization is what clears the staged handle.
    expect(
      await client.page.evaluate((entityId) => {
        const state = window.__store?.getState()
        const workspaceId =
          (state?.unifiedTabsByWorktree[Object.keys(state.unifiedTabsByWorktree)[0]] ?? []).find(
            (tab) => tab.id === entityId
          )?.entityId ?? ''
        return (state?.browserPagesByWorkspace[workspaceId] ?? []).map(
          (page) => state?.remoteBrowserPageHandlesByPageId[page.id]?.staged ?? false
        )
      }, timings.tabIdAtFirstSight ?? '')
    ).toEqual([false])
  } finally {
    await fixture.dispose()
  }
})

test('keeps three rapid paired browser creates as three ordered tabs', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const before = requireGroup(await readPanes(client.page, worktreeId), rootGroupId)

    // Three clicks with no await between them, the way an impatient user hits "+".
    const stagedImmediately = await client.page.evaluate(
      async ({ groupId, url, worktreeId }) => {
        const store = window.__store
        const state = store?.getState()
        if (!store || !state) {
          throw new Error('Paired client store unavailable')
        }
        state.setBrowserDefaultUrl(url)
        const creates = [1, 2, 3].map(() =>
          state.openNewBrowserTabInActiveWorkspace(groupId).catch(() => undefined)
        )
        const browserTabCount = (): number =>
          (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).filter(
            (tab) => tab.contentType === 'browser'
          ).length
        const startedAt = performance.now()
        while (performance.now() - startedAt < 30_000 && browserTabCount() < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2))
        }
        const staged = browserTabCount()
        await Promise.all(creates)
        return staged
      },
      { groupId: rootGroupId, url: fixture.url, worktreeId }
    )
    expect(stagedImmediately).toBe(3)

    const after = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rootGroupId,
      before.tabOrder.length + 3,
      'paired client did not settle on exactly three browser tabs'
    )
    const group = requireGroup(after, rootGroupId)
    expect(group.tabOrder.slice(0, before.tabOrder.length)).toEqual(before.tabOrder)
    const browserTabIds = group.tabOrder.slice(before.tabOrder.length)
    expect(new Set(browserTabIds).size).toBe(3)
    expect(
      browserTabIds.every(
        (tabId) => after.tabs.find((tab) => tab.id === tabId)?.contentType === 'browser'
      )
    ).toBe(true)

    // Why: cross-rekeying would leave two tabs pointing at one workspace and one orphan.
    expect(
      new Set(
        browserTabIds.map((tabId) => after.tabs.find((tab) => tab.id === tabId)?.entityId ?? '')
      ).size
    ).toBe(3)
  } finally {
    await fixture.dispose()
  }
})

// A failed staged create must remove the optimistic tab rather than leave dead feedback.
test('takes back the optimistic tab when the paired create fails to reconcile', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const before = requireGroup(await readPanes(client.page, worktreeId), rootGroupId)

    await client.page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser creation E2E fault seam unavailable')
      }
      fault.arm()
    })
    await client.page.evaluate(
      ({ groupId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Paired client store unavailable')
        }
        state.setBrowserDefaultUrl(url)
        const create = state.openNewBrowserTabInActiveWorkspace(groupId).catch(() => undefined)
        ;(window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate = create
      },
      { groupId: rootGroupId, url: fixture.url }
    )

    // The staged tab is visible while the create is held at the fault seam.
    const held = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rootGroupId,
      before.tabOrder.length + 1,
      'paired client never staged the optimistic browser tab'
    )
    const stagedTabId = requireGroup(held, rootGroupId).tabOrder.at(-1)
    expect(held.tabs.find((tab) => tab.id === stagedTabId)?.contentType).toBe('browser')

    await expect
      .poll(
        () =>
          client.page.evaluate(
            () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
          ),
        { timeout: 60_000, message: 'held browser create never reached the fault seam' }
      )
      .toMatchObject({ armed: true, createdPageId: expect.any(String) })

    expect(
      await client.page.evaluate(
        () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.release() ?? false
      )
    ).toBe(true)
    await client.page.evaluate(
      () => (window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate
    )

    const settled = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rootGroupId,
      before.tabOrder.length,
      'failed browser create left its optimistic tab behind'
    )
    expect(requireGroup(settled, rootGroupId).tabOrder).toEqual(before.tabOrder)
    expect(requireGroup(settled, rootGroupId).activeTabId).toBe(before.activeTabId)
    expect(settled.tabs.filter((tab) => tab.contentType === 'browser')).toEqual([])
    // Why: rollback must clear the backing rows too, not just the strip entry.
    expect(
      await client.page.evaluate(
        (id) => (window.__store?.getState().browserTabsByWorktree[id] ?? []).length,
        worktreeId
      )
    ).toBe(0)
    await client.page.evaluate(() =>
      (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset()
    )
  } finally {
    await fixture.dispose()
  }
})

// Closing an in-flight staged tab cannot target an unminted host page; successful create must later retire it without resurrecting the tab.
test('cancels a held paired browser create when its staged tab is closed from the strip', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const before = requireGroup(await readPanes(client.page, worktreeId), rootGroupId)
    await recordBrowserTabTransitions(fixture)

    await client.page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser creation E2E fault seam unavailable')
      }
      fault.arm()
    })
    await client.page.evaluate(
      ({ groupId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Paired client store unavailable')
        }
        state.setBrowserDefaultUrl(url)
        const create = state.openNewBrowserTabInActiveWorkspace(groupId).catch(() => undefined)
        ;(window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate = create
      },
      { groupId: rootGroupId, url: fixture.url }
    )

    const held = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rootGroupId,
      before.tabOrder.length + 1,
      'paired client never staged the optimistic browser tab'
    )
    const stagedTab = held.tabs.find(
      (tab) => tab.id === requireGroup(held, rootGroupId).tabOrder.at(-1)
    )
    expect(stagedTab?.contentType).toBe('browser')
    // The host really did mint a page, so an unhandled cancel would leave a real orphan.
    await expect
      .poll(
        () =>
          client.page.evaluate(
            () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
          ),
        { timeout: 60_000, message: 'held browser create never reached the fault seam' }
      )
      .toMatchObject({ armed: true, createdPageId: expect.any(String) })

    // The user's X, on the real tab strip, while the create is still held.
    await client.page
      .locator(
        `[data-tab-group-strip-id="${rootGroupId}"] [data-tab-id="${stagedTab?.entityId}"] button`
      )
      .click()
    const cancelled = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rootGroupId,
      before.tabOrder.length,
      'the strip X left the staged browser tab standing'
    )
    expect(cancelled.tabs.filter((tab) => tab.contentType === 'browser')).toEqual([])

    // Reset clears the hold and snapshot suppression without injecting failure; release would clean up independently and mask broken cancellation.
    await client.page.evaluate(() =>
      (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset()
    )
    await client.page.evaluate(
      () => (window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate
    )

    // Check the host list for retirement; client row removal alone can hide an orphan.
    await expect
      .poll(() => readHostBrowserPageIds(fixture.host.client, testRepoPath), {
        timeout: 60_000,
        message: 'host kept the page from the cancelled create'
      })
      .toEqual([])
    // Wait for unsuppressed snapshots to expose a delayed resurrection.
    await client.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 3_000)))
    const settled = await readPanes(client.page, worktreeId)
    expect(requireGroup(settled, rootGroupId).tabOrder).toEqual(before.tabOrder)
    expect(settled.activeGroupId).toBe(rootGroupId)
    expect(
      await client.page.evaluate(
        (id) => (window.__store?.getState().browserTabsByWorktree[id] ?? []).length,
        worktreeId
      )
    ).toBe(0)
    // Keep transition history to catch resurrection followed by reconciliation removal.
    const transitions = await readBrowserTabTransitions(fixture)
    expect(transitions.at(-1)).toBe('')
    expect(transitions.filter((entry) => entry !== '')).toHaveLength(1)
  } finally {
    await fixture.dispose()
  }
})

// Rollback must preserve workspace selection even when the only tab disappears, unlike an intentional final-tab close.
test('leaves the user on an empty worktree when its first browser create fails', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture

    // Empty the worktree, then stand in it again — closing the last tab deselects it by design.
    await client.page.evaluate(
      ({ groupId, worktreeId }) => {
        const store = window.__store
        const state = store?.getState()
        if (!store || !state) {
          throw new Error('Paired client store unavailable')
        }
        const group = (state.groupsByWorktree[worktreeId] ?? []).find(
          (candidate) => candidate.id === groupId
        )
        // Safe to iterate while closing: the store replaces tabOrder rather than mutating it.
        const tabOrder = group?.tabOrder ?? []
        for (const tabId of tabOrder) {
          store.getState().closeUnifiedTab(tabId)
        }
        store.getState().setActiveWorktree(worktreeId)
      },
      { groupId: rootGroupId, worktreeId }
    )
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) => ({
              activeWorktreeId: window.__store?.getState().activeWorktreeId ?? null,
              tabCount: (window.__store?.getState().unifiedTabsByWorktree[id] ?? []).length
            }),
            worktreeId
          ),
        { timeout: 30_000, message: 'worktree never settled empty-but-selected' }
      )
      .toEqual({ activeWorktreeId: worktreeId, tabCount: 0 })

    await client.page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser creation E2E fault seam unavailable')
      }
      fault.arm()
    })
    await client.page.evaluate(
      ({ groupId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Paired client store unavailable')
        }
        state.setBrowserDefaultUrl(url)
        const create = state.openNewBrowserTabInActiveWorkspace(groupId).catch(() => undefined)
        ;(window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate = create
      },
      { groupId: rootGroupId, url: fixture.url }
    )
    // Observe the worktree because its group exists only while the optimistic tab exists.
    await expect
      .poll(() => readEmptyWorktreeState(client.page, worktreeId), {
        timeout: 60_000,
        message: 'paired client never staged the optimistic browser tab in the empty worktree'
      })
      .toEqual({ activeWorktreeId: worktreeId, browserTabs: 1, browserWorkspaces: 1 })

    await expect
      .poll(
        () =>
          client.page.evaluate(
            () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
          ),
        { timeout: 60_000, message: 'held browser create never reached the fault seam' }
      )
      .toMatchObject({ armed: true, createdPageId: expect.any(String) })
    expect(
      await client.page.evaluate(
        () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.release() ?? false
      )
    ).toBe(true)
    await client.page.evaluate(
      () => (window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate
    )

    // The rollback unwinds the tab AND leaves the user standing where they clicked.
    await expect
      .poll(() => readEmptyWorktreeState(client.page, worktreeId), {
        timeout: 90_000,
        message: 'failed browser create left its optimistic tab behind'
      })
      .toEqual({ activeWorktreeId: worktreeId, browserTabs: 0, browserWorkspaces: 0 })
    await client.page.evaluate(() =>
      (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset()
    )
  } finally {
    await fixture.dispose()
  }
})

/** Arm the create seam and start a create that will hold, staged, until the seam is reset. */
async function startHeldCreate(
  fixture: Awaited<ReturnType<typeof setUpPairedFixture>>,
  groupId: string
): Promise<void> {
  const { client, worktreeId } = fixture
  await client.page.evaluate(() => {
    const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
    if (!fault) {
      throw new Error('Browser creation E2E fault seam unavailable')
    }
    fault.arm()
  })
  await client.page.evaluate(
    ({ groupId, url }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired client store unavailable')
      }
      state.setBrowserDefaultUrl(url)
      const create = state.openNewBrowserTabInActiveWorkspace(groupId).catch(() => undefined)
      ;(window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate = create
    },
    { groupId, url: fixture.url }
  )
  await expect
    .poll(() => readActiveBrowserPlacementKind(client.page, worktreeId), {
      timeout: 60_000,
      message: 'paired client never staged the optimistic browser tab'
    })
    .toBe('staged')
  await expect
    .poll(
      () =>
        client.page.evaluate(
          () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
        ),
      { timeout: 60_000, message: 'held browser create never reached the fault seam' }
    )
    .toMatchObject({ armed: true, createdPageId: expect.any(String) })
}

/** Release the seam without arming a reconciliation failure, then wait for adoption. */
async function releaseHeldCreateAndAdopt(
  fixture: Awaited<ReturnType<typeof setUpPairedFixture>>
): Promise<void> {
  const { client, worktreeId } = fixture
  await client.page.evaluate(() =>
    (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset()
  )
  await client.page.evaluate(
    () => (window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate
  )
  await expect
    .poll(() => readActiveBrowserPlacementKind(client.page, worktreeId), {
      timeout: 90_000,
      message: 'the held create never adopted its staged tab'
    })
    .toBe('client')
  // Wait after adoption so delayed snapshots can expose regressions.
  await client.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 3_000)))
}

/** The browser tab's unified id, whichever group it currently sits in. */
async function readBrowserTabId(
  page: Awaited<ReturnType<typeof setUpPairedFixture>>['client']['page'],
  worktreeId: string
): Promise<string | null> {
  return page.evaluate(
    (id) =>
      (window.__store?.getState().unifiedTabsByWorktree[id] ?? []).find(
        (tab) => tab.contentType === 'browser'
      )?.id ?? null,
    worktreeId
  )
}

// Use the tab’s current group after a staged split; its original requested group would undo the user’s move.
test('keeps a split made while the paired create is still staged', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    await startHeldCreate(fixture, rootGroupId)

    // The user drags the staged tab out into a new pane while the create is still held.
    const stagedTabId = await readBrowserTabId(client.page, worktreeId)
    expect(stagedTabId).not.toBeNull()
    await client.page.evaluate(
      ({ groupId, tabId }) =>
        window.__store?.getState().dropUnifiedTab(tabId, { groupId, splitDirection: 'right' }),
      { groupId: rootGroupId, tabId: stagedTabId as string }
    )
    const split = await readPanes(client.page, worktreeId)
    const splitGroupId = split.groups.find((group) =>
      group.tabOrder.includes(stagedTabId as string)
    )?.id
    expect(splitGroupId).toBeDefined()
    expect(splitGroupId).not.toBe(rootGroupId)
    expect(split.layoutGroupIds).toContain(splitGroupId)

    await releaseHeldCreateAndAdopt(fixture)

    const adopted = await readPanes(client.page, worktreeId)
    const adoptedTabId = await readBrowserTabId(client.page, worktreeId)
    expect(requireGroup(adopted, splitGroupId as string).tabOrder).toContain(adoptedTabId)
    expect(adopted.layoutGroupIds).toContain(splitGroupId)
  } finally {
    await fixture.dispose()
  }
})

// Hold host preparation: the old focus baseline sampled after that roundtrip and incorrectly accepted an intervening user switch.
test('leaves the user on the tab they switched to during client-host preparation', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const before = requireGroup(await readPanes(client.page, worktreeId), rootGroupId)
    const otherTabId = before.tabOrder[0]
    expect(otherTabId).toBeDefined()

    await client.page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser creation E2E fault seam unavailable')
      }
      fault.armPreparation()
    })
    await client.page.evaluate(
      ({ groupId, url }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Paired client store unavailable')
        }
        state.setBrowserDefaultUrl(url)
        const create = state.openNewBrowserTabInActiveWorkspace(groupId).catch(() => undefined)
        ;(window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate = create
      },
      { groupId: rootGroupId, url: fixture.url }
    )
    await expect
      .poll(
        () =>
          client.page.evaluate(
            () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
          ),
        { timeout: 60_000, message: 'the create never reached the client-host preparation seam' }
      )
      .toMatchObject({ preparationReached: true })
    // Staging already happened and activated the new tab, so this is a real move away from it.
    await expect
      .poll(() => readActiveBrowserPlacementKind(client.page, worktreeId), {
        timeout: 60_000,
        message: 'paired client never staged the optimistic browser tab'
      })
      .toBe('staged')
    expect(
      requireGroup(await readPanes(client.page, worktreeId), rootGroupId).activeTabId
    ).not.toBe(otherTabId)

    // The user clicks back to their terminal while the desktop host is still being prepared.
    await client.page.evaluate(
      (tabId) => window.__store?.getState().activateTab(tabId),
      otherTabId as string
    )
    expect(requireGroup(await readPanes(client.page, worktreeId), rootGroupId).activeTabId).toBe(
      otherTabId
    )

    await client.page.evaluate(() =>
      (window as FaultWindow).__webRuntimeBrowserCreationFault?.releasePreparation()
    )
    await client.page.evaluate(
      () => (window as unknown as { __heldBrowserCreate: Promise<void> }).__heldBrowserCreate
    )
    await expect
      .poll(() => readActiveBrowserPlacementKind(client.page, worktreeId), {
        timeout: 90_000,
        message: 'the create never adopted its staged tab'
      })
      .toBe('client')
    await client.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 3_000)))

    const adopted = await readPanes(client.page, worktreeId)
    expect(requireGroup(adopted, rootGroupId).activeTabId).toBe(otherTabId)
    expect(adopted.activeGroupId).toBe(rootGroupId)
  } finally {
    await fixture.dispose()
  }
})

// Require the same address input node: restoring its text across remount still replays dropdown animation and drops the guest.
test('adopts a paired browser tab without rebuilding its chrome', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    await startHeldCreate(fixture, rootGroupId)
    await client.page.locator('[data-orca-browser-address-bar]').first().waitFor()

    // Mark the live node. A remount builds a new input, which cannot carry this.
    const marked = await client.page.evaluate(() => {
      const input = document.querySelector('[data-orca-browser-address-bar]')
      if (!input) {
        return false
      }
      input.setAttribute('data-e2e-staged-address-bar', 'marked')
      return true
    })
    expect(marked).toBe(true)

    await releaseHeldCreateAndAdopt(fixture)

    expect(
      await client.page.evaluate(() => ({
        bars: document.querySelectorAll('[data-orca-browser-address-bar]').length,
        marked: document.querySelectorAll('[data-e2e-staged-address-bar="marked"]').length,
        sameNode:
          document.querySelector('[data-orca-browser-address-bar]') ===
          document.querySelector('[data-e2e-staged-address-bar="marked"]')
      }))
    ).toEqual({ bars: 1, marked: 1, sameNode: true })
    expect(requireGroup(await readPanes(client.page, worktreeId), rootGroupId)).toBeDefined()
  } finally {
    await fixture.dispose()
  }
})
