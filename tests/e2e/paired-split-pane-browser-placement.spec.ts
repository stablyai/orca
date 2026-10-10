import { expect, test } from './helpers/orca-app'
import { readHostBrowserPageIds } from './helpers/host-session-tabs'
import {
  contentTypesOf,
  openRemoteBrowserTab,
  pushHostSnapshot,
  readPanes,
  requireGroup,
  setUpPairedFixture,
  waitForGroupTabCount
} from './helpers/paired-browser-placement-fixture'

test('appends a paired browser tab last in its pane and keeps it there across host snapshots', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const before = await readPanes(client.page, worktreeId)
    const terminalOrder = requireGroup(before, rootGroupId).tabOrder
    expect(contentTypesOf(before, rootGroupId).every((kind) => kind === 'terminal')).toBe(true)

    await openRemoteBrowserTab(client.page, fixture.url, rootGroupId)
    const after = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rootGroupId,
      terminalOrder.length + 1,
      'paired client never materialized the remote browser tab in the root group'
    )
    const placed = requireGroup(after, rootGroupId).tabOrder
    expect(placed.slice(0, terminalOrder.length)).toEqual(terminalOrder)
    expect(contentTypesOf(after, rootGroupId).at(-1)).toBe('browser')

    // Why: the shipped bug only appeared once ambient host snapshots re-reconciled the group.
    for (const title of ['Placement Alpha rev1', 'Placement Alpha rev2']) {
      await pushHostSnapshot(fixture, fixture.terminalHandles[0], title)
      const settled = await readPanes(client.page, worktreeId)
      expect(requireGroup(settled, rootGroupId).tabOrder).toEqual(placed)
      expect(contentTypesOf(settled, rootGroupId).at(-1)).toBe('browser')
    }
  } finally {
    await fixture.dispose()
  }
})

test('creates paired split-pane tabs in the focused pane without disturbing the other pane', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const leftBefore = requireGroup(await readPanes(client.page, worktreeId), rootGroupId)

    const rightGroupId = await client.page.evaluate(
      ({ sourceGroupId, worktreeId }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Paired client store unavailable')
        }
        const groupId = state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right')
        if (!groupId) {
          throw new Error('Right split group unavailable')
        }
        state.focusGroup(worktreeId, groupId)
        return groupId
      },
      { sourceGroupId: rootGroupId, worktreeId }
    )

    // Scenario B: a browser created from the right pane must land there and leave the left alone.
    await openRemoteBrowserTab(client.page, fixture.url, rightGroupId)
    const withBrowser = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rightGroupId,
      1,
      'paired client never materialized the remote browser tab in the right pane'
    )
    const browserTabId = requireGroup(withBrowser, rightGroupId).tabOrder[0]
    expect(withBrowser.tabs.find((tab) => tab.id === browserTabId)?.contentType).toBe('browser')
    expect(withBrowser.tabs.find((tab) => tab.id === browserTabId)?.groupId).toBe(rightGroupId)
    expect(requireGroup(withBrowser, rootGroupId).tabOrder).toEqual(leftBefore.tabOrder)
    expect(requireGroup(withBrowser, rootGroupId).activeTabId).toBe(leftBefore.activeTabId)
    expect(withBrowser.activeGroupId).toBe(rightGroupId)

    // Scenario D: ambient host snapshots must not steal focus back from the left pane.
    const leftTerminalId = leftBefore.tabOrder[0]
    await client.page.evaluate(
      ({ groupId, tabId, worktreeId }) => {
        const state = window.__store?.getState()
        state?.focusGroup(worktreeId, groupId)
        state?.activateTab(tabId, { worktreeId })
      },
      { groupId: rootGroupId, tabId: leftTerminalId, worktreeId }
    )
    await expect
      .poll(async () => (await readPanes(client.page, worktreeId)).activeGroupId, {
        timeout: 30_000,
        message: 'left pane never took focus'
      })
      .toBe(rootGroupId)
    const focused = await readPanes(client.page, worktreeId)
    expect(requireGroup(focused, rootGroupId).activeTabId).toBe(leftTerminalId)

    await pushHostSnapshot(fixture, fixture.terminalHandles[1], 'Placement Beta rev1')
    await pushHostSnapshot(fixture, fixture.terminalHandles[1], 'Placement Beta rev2')
    const settled = await readPanes(client.page, worktreeId)
    expect(settled.activeGroupId).toBe(rootGroupId)
    expect(requireGroup(settled, rootGroupId).activeTabId).toBe(leftTerminalId)
    expect(requireGroup(settled, rootGroupId).tabOrder).toEqual(leftBefore.tabOrder)
    expect(requireGroup(settled, rightGroupId).activeTabId).toBe(browserTabId)
    expect(requireGroup(settled, rightGroupId).tabOrder).toEqual([browserTabId])
  } finally {
    await fixture.dispose()
  }
})

// Why: a remote-owned browser closes on the host and never runs the local closeUnifiedTab
// collapse, so the emptied split pane can only disappear via the snapshot reconciler.
test('collapses the split pane when its last paired browser tab is closed from the tab strip', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const rightGroupId = await client.page.evaluate(
      ({ sourceGroupId, worktreeId }) => {
        const state = window.__store?.getState()
        const groupId = state?.createEmptySplitGroup(worktreeId, sourceGroupId, 'right')
        if (!groupId) {
          throw new Error('Right split group unavailable')
        }
        state?.focusGroup(worktreeId, groupId)
        return groupId
      },
      { sourceGroupId: rootGroupId, worktreeId }
    )
    await openRemoteBrowserTab(client.page, fixture.url, rightGroupId)
    const split = await waitForGroupTabCount(
      client.page,
      worktreeId,
      rightGroupId,
      1,
      'paired client never materialized the remote browser tab in the right pane'
    )
    expect(split.layoutGroupIds).toEqual([rootGroupId, rightGroupId])
    const browserTab = split.tabs.find(
      (tab) => tab.id === requireGroup(split, rightGroupId).tabOrder[0]
    )
    expect(browserTab?.contentType).toBe('browser')

    // Why: a local-only close would collapse the pane on its own, so this test only guards the
    // remote-owned route while the host really holds the page. Ask the host — a client-side redo
    // of the ownership rule stops guarding the moment that rule changes.
    const hostPagesBefore = await readHostBrowserPageIds(fixture.host.client, testRepoPath)
    expect(hostPagesBefore).toHaveLength(1)

    await client.page
      .locator(
        `[data-tab-group-strip-id="${rightGroupId}"] [data-tab-id="${browserTab?.entityId}"] button`
      )
      .click()

    try {
      await expect
        .poll(
          async () => {
            const panes = await readPanes(client.page, worktreeId)
            return {
              browserTabs: panes.tabs.filter((tab) => tab.contentType === 'browser').length,
              groupIds: panes.groups.map((group) => group.id),
              layoutGroupIds: panes.layoutGroupIds
            }
          },
          {
            timeout: 90_000,
            message: 'emptied right pane never collapsed after the tab-strip close'
          }
        )
        .toEqual({ browserTabs: 0, groupIds: [rootGroupId], layoutGroupIds: [rootGroupId] })
    } catch (error) {
      throw new Error(
        `right pane never collapsed; panes=${JSON.stringify(await readPanes(client.page, worktreeId))}`,
        { cause: error }
      )
    }
    const collapsed = await readPanes(client.page, worktreeId)
    expect(collapsed.activeGroupId).toBe(rootGroupId)
    // Why: the pane collapsing proves the client removed its mirror; only the host's own tab list
    // proves the close actually reached the runtime that owned the page.
    await expect
      .poll(() => readHostBrowserPageIds(fixture.host.client, testRepoPath), {
        timeout: 30_000,
        message: 'host kept the browser page after the tab-strip close'
      })
      .toEqual([])
  } finally {
    await fixture.dispose()
  }
})

// Why: terminals record a client placement derived from targetGroupId (the host does not
// know client-minted split groups), so the mirrored tab must land in the requesting pane.
test('places a paired split-pane terminal in the pane that asked for it', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await setUpPairedFixture(testInfo, testRepoPath)
  try {
    const { client, rootGroupId, worktreeId } = fixture
    const rightGroupId = await client.page.evaluate(
      ({ sourceGroupId, worktreeId }) => {
        const state = window.__store?.getState()
        const groupId = state?.createEmptySplitGroup(worktreeId, sourceGroupId, 'right')
        if (!groupId) {
          throw new Error('Right split group unavailable')
        }
        state?.focusGroup(worktreeId, groupId)
        return groupId
      },
      { sourceGroupId: rootGroupId, worktreeId }
    )
    await openRemoteBrowserTab(client.page, fixture.url, rightGroupId)
    await waitForGroupTabCount(
      client.page,
      worktreeId,
      rightGroupId,
      1,
      'paired client never materialized the remote browser tab in the right pane'
    )

    const terminalsBefore = new Set(
      (await readPanes(client.page, worktreeId)).tabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => tab.id)
    )
    // Why: this is what the tab strip's "+" → Terminal item calls for that panel's group.
    await client.page.evaluate(async (groupId) => {
      await window.__store?.getState().openNewTerminalTabInActiveWorkspace(groupId)
    }, rightGroupId)
    const findCreatedTerminal = async () =>
      (await readPanes(client.page, worktreeId)).tabs.find(
        (tab) => tab.contentType === 'terminal' && !terminalsBefore.has(tab.id)
      ) ?? null
    await expect
      .poll(findCreatedTerminal, {
        timeout: 90_000,
        message: 'paired client never materialized the new terminal'
      })
      .not.toBeNull()

    const panes = await readPanes(client.page, worktreeId)
    expect((await findCreatedTerminal())?.groupId).toBe(rightGroupId)
    expect(contentTypesOf(panes, rightGroupId)).toEqual(['browser', 'terminal'])
    expect(panes.activeGroupId).toBe(rightGroupId)
  } finally {
    await fixture.dispose()
  }
})
