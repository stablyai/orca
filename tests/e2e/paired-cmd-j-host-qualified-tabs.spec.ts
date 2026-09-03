import { errors } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'

test('routes same-id browser and simulator Cmd-J rows to their owning paired host', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const hostBrowser = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('Host has no active worktree for the paired Cmd-J fixture')
    }
    const workspace = state.createBrowserTab(
      worktreeId,
      'data:text/html,<title>Remote browser proof</title>',
      { activate: false, title: 'Remote browser proof' }
    )
    return { worktreeId, workspaceId: workspace.id }
  })

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'Cmd-J host-qualified tabs')
    const page = client.page
    await page.evaluate(() => {
      window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
    })
    const drawHintDismiss = page.getByRole('button', { name: 'Got it', exact: true })
    const drawHintVisible = await drawHintDismiss
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof errors.TimeoutError) {
          return false
        }
        throw error
      })
    if (drawHintVisible) {
      await drawHintDismiss.click()
    }
    const remoteHostId = `runtime:${encodeURIComponent(client.environmentId)}` as const
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ worktreeId, workspaceId }) => {
              const state = window.__store?.getState()
              const tab = (state?.unifiedTabsByWorktree[worktreeId] ?? []).find(
                (candidate) =>
                  candidate.contentType === 'browser' && candidate.entityId === workspaceId
              )
              return tab?.executionHostId ?? null
            },
            { worktreeId: hostBrowser.worktreeId, workspaceId: hostBrowser.workspaceId }
          ),
        { timeout: 60_000, message: 'paired client never mirrored the host browser tab' }
      )
      .toBe(remoteHostId)
    // Why: hydration's deferred all-host scan rewrites worktreesByRepo; seeding ahead of it is silently reaped.
    await waitForStartupWorktreeRefresh(page)
    // Why: empties the mirror's reachable-target set, so the session.tabs subscription tears down before seeding.
    await page.evaluate(() => {
      window.__store!.setState({
        runtimeEnvironments: [],
        runtimeStatusByEnvironmentId: new Map()
      })
    })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const seeded = await page.evaluate(
      ({ remoteHostId, sharedWorktreeId, hostWorkspaceId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Paired client store is unavailable')
        }
        const state = store.getState()
        const seed = state
          .allWorktrees()
          .find((worktree) => worktree.id === sharedWorktreeId && worktree.hostId === remoteHostId)
        const seedRepo = state.repos.find(
          (repo) => repo.id === seed?.repoId && repo.executionHostId === remoteHostId
        )
        const remoteBrowser = (state.browserTabsByWorktree[sharedWorktreeId] ?? []).find(
          (workspace) => workspace.id === hostWorkspaceId
        )
        const remotePage = remoteBrowser
          ? (state.browserPagesByWorkspace[remoteBrowser.id] ?? [])[0]
          : null
        const remoteUnifiedTab = (state.unifiedTabsByWorktree[sharedWorktreeId] ?? []).find(
          (tab) => tab.contentType === 'browser' && tab.entityId === remoteBrowser?.id
        )
        const remoteGroup = (state.groupsByWorktree[sharedWorktreeId] ?? []).find(
          (group) => group.id === remoteUnifiedTab?.groupId
        )
        if (
          !seed ||
          !seedRepo ||
          !remoteBrowser ||
          !remotePage ||
          !remoteUnifiedTab ||
          !remoteGroup
        ) {
          throw new Error('Paired client did not retain the mirrored host browser topology')
        }
        // Why: the fixture nests the client's own layout under its local pane, so the remote group
        // has to already be rendered there — otherwise the remote rows silently stop being visible.
        const renderedGroupIds = new Set<string>()
        const pendingLayoutNodes = [state.layoutByWorktree[sharedWorktreeId]]
        while (pendingLayoutNodes.length > 0) {
          const node = pendingLayoutNodes.pop()
          if (!node) {
            continue
          }
          if (node.type === 'leaf') {
            renderedGroupIds.add(node.groupId)
            continue
          }
          pendingLayoutNodes.push(node.first, node.second)
        }
        if (renderedGroupIds.size > 0 && !renderedGroupIds.has(remoteGroup.id)) {
          throw new Error('Paired client layout does not render the mirrored host browser group')
        }
        const local = {
          ...seed,
          hostId: 'local' as const,
          runtimeOwnerEnvironmentId: undefined,
          displayName: 'Local collision workspace'
        }
        const remote = {
          ...seed,
          hostId: remoteHostId,
          displayName: 'Remote collision workspace'
        }
        const localBrowser = {
          id: 'browser-local',
          worktreeId: sharedWorktreeId,
          activePageId: 'page-local',
          pageIds: ['page-local'],
          url: 'https://local.example.test',
          title: 'Local browser proof',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
        const seededRemoteBrowser = {
          ...remoteBrowser,
          title: 'Remote browser proof'
        }
        const tab = (
          id: string,
          entityId: string,
          groupId: string,
          executionHostId: 'local' | `runtime:${string}`,
          contentType: 'browser' | 'simulator',
          label: string
        ) => ({
          id,
          entityId,
          groupId,
          worktreeId: sharedWorktreeId,
          executionHostId,
          contentType,
          label,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        })
        // Why: a session.tabs frame rebuilds the host's live tabs from the snapshot either way;
        // keeping their ids in the groups' tabOrder is what makes placement treat them as already
        // known, so the frame re-lands them where they are instead of adopting them into a group.
        const retainedMirroredTabs = (state.unifiedTabsByWorktree[sharedWorktreeId] ?? []).map(
          (candidate) =>
            candidate.id === remoteUnifiedTab.id
              ? { ...candidate, executionHostId: remoteHostId }
              : candidate
        )
        const tabs = [
          tab('browser-tab-local', 'browser-local', 'group-local', 'local', 'browser', 'Local'),
          tab(
            'simulator-local',
            'simulator-local',
            'group-local',
            'local',
            'simulator',
            'Local emulator proof'
          ),
          tab(
            'simulator-remote',
            'simulator-remote',
            remoteGroup.id,
            remoteHostId,
            'simulator',
            'Remote emulator proof'
          ),
          ...retainedMirroredTabs
        ]
        store.setState({
          worktreesByRepo: { ...state.worktreesByRepo, [seed.repoId]: [local, remote] },
          activeRepoId: seed.repoId,
          activeWorktreeId: sharedWorktreeId,
          activeWorkspaceExecutionHostId: 'local',
          browserTabsByWorktree: {
            ...state.browserTabsByWorktree,
            [sharedWorktreeId]: [localBrowser, seededRemoteBrowser]
          },
          browserPagesByWorkspace: {
            ...state.browserPagesByWorkspace,
            [remoteBrowser.id]: [
              { ...remotePage, url: 'data:text/html,', title: 'Remote browser proof' }
            ],
            'browser-local': [
              {
                id: 'page-local',
                workspaceId: 'browser-local',
                worktreeId: sharedWorktreeId,
                url: localBrowser.url,
                title: localBrowser.title,
                loading: false,
                faviconUrl: null,
                canGoBack: false,
                canGoForward: false,
                loadError: null,
                createdAt: 1
              }
            ]
          },
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [sharedWorktreeId]: tabs },
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [sharedWorktreeId]: [
              {
                id: 'group-local',
                worktreeId: sharedWorktreeId,
                activeTabId: 'browser-tab-local',
                tabOrder: ['browser-tab-local', 'simulator-local']
              },
              ...(state.groupsByWorktree[sharedWorktreeId] ?? []).map((group) =>
                group.id === remoteGroup.id
                  ? {
                      ...group,
                      activeTabId: remoteUnifiedTab.id,
                      tabOrder: [...group.tabOrder, 'simulator-remote']
                    }
                  : group
              )
            ]
          },
          activeGroupIdByWorktree: {
            ...state.activeGroupIdByWorktree,
            [sharedWorktreeId]: 'group-local'
          },
          layoutByWorktree: {
            ...state.layoutByWorktree,
            [sharedWorktreeId]: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', groupId: 'group-local' },
              // Why: wrap the client's own layout so a host-side split keeps rendering its panes.
              second: state.layoutByWorktree[sharedWorktreeId] ?? {
                type: 'leaf',
                groupId: remoteGroup.id
              },
              ratio: 0.5
            }
          },
          activeBrowserTabId: 'browser-local',
          activeBrowserTabIdByWorktree: {
            ...state.activeBrowserTabIdByWorktree,
            [sharedWorktreeId]: 'browser-local'
          },
          activeTabType: 'browser',
          activeTabTypeByWorktree: {
            ...state.activeTabTypeByWorktree,
            [sharedWorktreeId]: 'browser'
          }
        })
        return {
          remoteGroupId: remoteGroup.id,
          remotePageId: remotePage.id,
          remoteTabId: remoteUnifiedTab.id,
          remoteWorkspaceId: remoteBrowser.id,
          sharedWorktreeId
        }
      },
      {
        hostWorkspaceId: hostBrowser.workspaceId,
        remoteHostId,
        sharedWorktreeId: hostBrowser.worktreeId
      }
    )

    const backing = await page.evaluate(
      ({ tabIds, worktreeId }) => {
        const state = window.__store!.getState()
        return {
          browserCount: state.browserTabsByWorktree[worktreeId]?.length,
          owners: state.unifiedTabsByWorktree[worktreeId]
            ?.filter((tab) => tabIds.includes(tab.id))
            .map((tab) => [tab.id, tab.executionHostId, tab.worktreeId]),
          workspaceOwners: state.browserTabsByWorktree[worktreeId]?.map((workspace) => [
            workspace.id,
            workspace.worktreeId
          ])
        }
      },
      {
        tabIds: ['browser-tab-local', seeded.remoteTabId, 'simulator-local', 'simulator-remote'],
        worktreeId: seeded.sharedWorktreeId
      }
    )
    expect(backing).toEqual({
      browserCount: 2,
      owners: [
        ['browser-tab-local', 'local', seeded.sharedWorktreeId],
        ['simulator-local', 'local', seeded.sharedWorktreeId],
        ['simulator-remote', remoteHostId, seeded.sharedWorktreeId],
        [seeded.remoteTabId, remoteHostId, seeded.sharedWorktreeId]
      ],
      workspaceOwners: [
        ['browser-local', seeded.sharedWorktreeId],
        [seeded.remoteWorkspaceId, seeded.sharedWorktreeId]
      ]
    })
    // Why: a live catalog refresh that reaps one same-id row re-hosts the surviving palette
    // entry, so assert the collision still exists at click time instead of blaming the palette.
    const expectSameIdCollisionIntact = async (step: string): Promise<void> => {
      expect(
        await page.evaluate(
          (worktreeId) =>
            window
              .__store!.getState()
              .allWorktrees()
              .filter((worktree) => worktree.id === worktreeId)
              .map((worktree) => worktree.hostId)
              .sort(),
          seeded.sharedWorktreeId
        ),
        `same-id host rows before ${step}`
      ).toEqual(['local', remoteHostId].sort())
    }
    await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    let palette = page.getByRole('dialog', { name: 'Jump to...' })
    let input = palette.getByPlaceholder(
      'Search chats, terminals, worktrees, settings, and actions...'
    )
    await expectSameIdCollisionIntact('remote browser page palette open')
    const remoteBrowserAfterOpen = await page.evaluate(
      ({ tabId, worktreeId }) => {
        const state = window.__store!.getState()
        const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (candidate) => candidate.id === tabId
        )
        return {
          browserCount: state.browserTabsByWorktree[worktreeId]?.length ?? 0,
          owner: tab?.executionHostId ?? null
        }
      },
      {
        tabId: seeded.remoteTabId,
        worktreeId: seeded.sharedWorktreeId
      }
    )
    expect(remoteBrowserAfterOpen.browserCount).toBe(2)
    expect(remoteBrowserAfterOpen.owner).toBe(remoteHostId)
    await input.fill('New Tab')
    await expect(
      palette.locator(`[cmdk-item][data-value="browser-page:${seeded.remotePageId}"]`)
    ).toHaveCount(1)
    await expect(palette.getByText('Local browser proof', { exact: true })).toHaveCount(0)
    await testInfo.attach('cmd-j-host-qualified-browser.png', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })
    await expectSameIdCollisionIntact('remote browser page click')
    await palette.locator(`[cmdk-item][data-value="browser-page:${seeded.remotePageId}"]`).click()
    await expect
      .poll(() =>
        page.evaluate((worktreeId) => {
          const state = window.__store!.getState()
          const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
          return [
            state.activeWorkspaceExecutionHostId,
            state.activeBrowserTabId,
            state.activeTabType,
            activeGroupId,
            (state.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
              ?.activeTabId
          ]
        }, seeded.sharedWorktreeId)
      )
      // Why the group's own activeTabId: `data-active` on a browser tab is the strip's active
      // tab, not `activeBrowserTabId`, so the simulator rows below already wait on it — asserting
      // the DOM off the global browser state alone races the group activation.
      .toEqual([
        remoteHostId,
        seeded.remoteWorkspaceId,
        'browser',
        seeded.remoteGroupId,
        seeded.remoteTabId
      ])
    await expect(palette).not.toBeVisible()
    await expect(
      page.locator(`[data-tab-id="${seeded.remoteWorkspaceId}"][data-active="true"]`).first()
    ).toBeVisible()
    await testInfo.attach('cmd-j-host-qualified-browser-selected.png', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })

    await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    palette = page.getByRole('dialog', { name: 'Jump to...' })
    input = palette.getByPlaceholder('Search chats, terminals, worktrees, settings, and actions...')
    await input.fill('local.example.test')
    await expect(palette.locator('[cmdk-item][data-value="browser-page:page-local"]')).toHaveCount(
      1
    )
    await expectSameIdCollisionIntact('local browser page click')
    await palette.locator('[cmdk-item][data-value="browser-page:page-local"]').click()
    await expect
      .poll(() =>
        page.evaluate((worktreeId) => {
          const state = window.__store!.getState()
          const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
          return [
            state.activeWorkspaceExecutionHostId,
            state.activeBrowserTabId,
            state.activeTabType,
            activeGroupId,
            (state.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
              ?.activeTabId
          ]
        }, seeded.sharedWorktreeId)
      )
      .toEqual(['local', 'browser-local', 'browser', 'group-local', 'browser-tab-local'])
    await expect(
      page.locator('[data-tab-id="browser-local"][data-active="true"]').first()
    ).toBeVisible()

    await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    palette = page.getByRole('dialog', { name: 'Jump to...' })
    input = palette.getByPlaceholder('Search chats, terminals, worktrees, settings, and actions...')
    await input.fill('Remote emulator proof')
    await expect(palette.getByText('Local emulator proof', { exact: true })).toHaveCount(0)
    await expect(palette.getByText('Remote emulator proof', { exact: true })).toHaveCount(1)
    await testInfo.attach('cmd-j-host-qualified-simulator.png', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })
    await expectSameIdCollisionIntact('remote simulator click')
    await palette.locator('[cmdk-item][data-value="simulator-tab:simulator-remote"]').click()
    await expect
      .poll(() =>
        page.evaluate((worktreeId) => {
          const state = window.__store!.getState()
          const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
          return [
            state.activeWorkspaceExecutionHostId,
            activeGroupId,
            (state.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
              ?.activeTabId
          ]
        }, seeded.sharedWorktreeId)
      )
      .toEqual([remoteHostId, seeded.remoteGroupId, 'simulator-remote'])
    await expect(
      page.locator('[data-tab-id="simulator-remote"][data-active="true"]').first()
    ).toBeVisible()
    await testInfo.attach('cmd-j-host-qualified-simulator-selected.png', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })

    await page.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    palette = page.getByRole('dialog', { name: 'Jump to...' })
    input = palette.getByPlaceholder('Search chats, terminals, worktrees, settings, and actions...')
    await input.fill('Local emulator proof')
    const localSimulatorRow = palette.locator(
      '[cmdk-item][data-value="simulator-tab:simulator-local"]'
    )
    await expect(localSimulatorRow).toHaveCount(1)
    await expectSameIdCollisionIntact('local simulator click')
    await localSimulatorRow.click()
    await expect
      .poll(() =>
        page.evaluate((worktreeId) => {
          const state = window.__store!.getState()
          const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
          return [
            state.activeWorkspaceExecutionHostId,
            activeGroupId,
            (state.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
              ?.activeTabId
          ]
        }, seeded.sharedWorktreeId)
      )
      .toEqual(['local', 'group-local', 'simulator-local'])
    await expect(
      page.locator('[data-tab-id="simulator-local"][data-active="true"]').first()
    ).toBeVisible()
  } finally {
    await client?.dispose()
  }
})
