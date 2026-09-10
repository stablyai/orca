import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('shows selected workspace terminals in Workspace Multiplexer', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({
      uiLanguage: 'en',
      skipDeleteWorktreeConfirm: false
    })
  )
  const activeWorktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async (worktreeId) => {
    const state = window.__store?.getState()
    if (!state || (state.tabsByWorktree[worktreeId] ?? []).length > 0) {
      return
    }
    const groupId = state.ensureWorktreeRootGroup(worktreeId)
    await window.__store?.getState().openNewTerminalTabInActiveWorkspace(groupId)
  }, activeWorktreeId)
  const originalTerminalIds = await orcaPage.evaluate(
    (worktreeId) =>
      (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
    activeWorktreeId
  )
  await orcaPage.evaluate((worktreeId) => {
    const store = window.__store
    const state = store?.getState()
    const worktree = state
      ? Object.values(state.worktreesByRepo)
          .flat()
          .find((candidate) => candidate.id === worktreeId)
      : null
    if (!store || !state || !worktree?.branch || !worktree.head) {
      throw new Error('Expected an active Git worktree')
    }
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const cacheKey = `local::${worktree.repoId}::${branch}`
    store.setState({
      hostedReviewCache: {
        ...state.hostedReviewCache,
        [cacheKey]: {
          data: {
            provider: 'github',
            number: 999_999,
            title: 'Merged review fixture',
            state: 'merged',
            url: 'https://example.test/review/999999',
            status: 'success',
            updatedAt: '2026-01-01T00:00:00.000Z',
            mergeable: 'MERGEABLE',
            headSha: worktree.head
          },
          fetchedAt: Date.now(),
          linkedReviewHintKey: ''
        }
      }
    })
  }, activeWorktreeId)

  const trigger = orcaPage.locator('[data-workspace-multiplexer-trigger]')
  await expect(trigger).toHaveAttribute('aria-label', 'Workspace Multiplexer')
  await trigger.click()
  await expect(orcaPage.locator('[data-workspace-multiplexer-page]')).toBeVisible()
  await expect(orcaPage.locator('[data-floating-terminal-toggle]')).toHaveCount(0)

  const header = orcaPage.locator('[data-workspace-multiplexer-page] > header')
  expect((await header.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(40)
  await header.getByRole('button', { name: 'Add workspace' }).click()
  const createForProject = orcaPage.locator('[data-workspace-multiplexer-create-project]').first()
  const projectIdentity = await createForProject.getAttribute(
    'data-workspace-multiplexer-create-project'
  )
  await createForProject.focus()
  await createForProject.press('Enter')
  await expect(orcaPage.getByRole('dialog', { name: 'Create worktree' })).toBeVisible()
  const selectedRepoId = await orcaPage.evaluate(
    () => (window.__store!.getState().modalData as { initialRepoId?: string }).initialRepoId
  )
  expect(selectedRepoId).toBeTruthy()
  expect(projectIdentity).toContain(`repo:${selectedRepoId}:`)
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.locator('[data-workspace-multiplexer-page]')).toBeVisible()
  await header.getByRole('button', { name: 'Add workspace' }).click()
  await orcaPage.getByRole('button', { name: 'Create worktree', exact: true }).click()
  await expect(orcaPage.getByRole('dialog', { name: 'Create worktree' })).toBeVisible()
  await orcaPage.keyboard.press('Escape')

  await header.getByRole('button', { name: 'Add workspace' }).click()
  await orcaPage.locator('[data-workspace-multiplexer-delete-worktree-id]').first().click()
  const deleteDialog = orcaPage.getByRole('dialog', { name: 'Delete Workspace' })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Cancel' }).click()

  await header.getByRole('button', { name: 'Add workspace' }).click()
  const activeOption = orcaPage.locator(
    `[data-workspace-multiplexer-worktree-id=${JSON.stringify(activeWorktreeId)}]`
  )
  await expect(activeOption).toHaveAttribute(
    'data-terminal-tab-count',
    String(originalTerminalIds.length)
  )
  await expect(activeOption).toHaveAttribute('data-workspace-activity-status', /.+/)
  await expect(activeOption).toHaveAttribute('data-workspace-status', /.+/)
  await expect(activeOption).toHaveAttribute('data-review-state', 'merged')
  await expect(activeOption.locator('.lucide-git-branch')).toHaveCount(0)
  await expect(activeOption.locator('.lucide-git-merge')).toHaveCount(1)
  await expect(
    activeOption.locator('[data-workspace-multiplexer-review-state="merged"]')
  ).toBeVisible()
  await activeOption.click()

  let tiles = orcaPage.locator('[data-workspace-multiplexer-slot-id]')
  await expect(tiles).toHaveCount(1)
  const workspaceTab = tiles.locator('[data-workspace-multiplexer-tab-id]')
  await expect(workspaceTab).toHaveAttribute('title', /.+ — .+/)
  await expect(workspaceTab).toHaveAttribute('data-review-state', 'merged')
  await expect(workspaceTab.locator('[data-workspace-multiplexer-workspace-icon]')).toBeVisible()
  await expect(workspaceTab.locator('[data-workspace-multiplexer-review-state]')).toBeVisible()
  expect((await workspaceTab.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(88)
  const tabGroupStrip = tiles.locator('[data-tab-group-strip-id]')
  const terminalTab = tabGroupStrip.locator('.terminal-tab-strip [data-tab-id]').first()
  await expect(terminalTab).toBeVisible()
  expect(
    await workspaceTab.evaluate((tab) => Boolean(tab.closest('[data-tab-group-strip-id]')))
  ).toBe(true)
  const [workspaceTabBox, terminalTabBox] = await Promise.all([
    workspaceTab.boundingBox(),
    terminalTab.boundingBox()
  ])
  expect(Math.abs((workspaceTabBox?.y ?? 0) - (terminalTabBox?.y ?? 0))).toBeLessThanOrEqual(1)
  expect((await tabGroupStrip.boundingBox())?.height).toBe(32)
  const hierarchyMarker = tiles.locator('[data-workspace-multiplexer-hierarchy-marker]')
  await expect(hierarchyMarker.locator('.lucide-chevron-right')).toBeVisible()
  const hierarchyMarkerBox = await hierarchyMarker.boundingBox()
  expect(hierarchyMarkerBox?.x ?? 0).toBeGreaterThanOrEqual(
    (workspaceTabBox?.x ?? 0) + (workspaceTabBox?.width ?? 0)
  )
  expect(terminalTabBox?.x ?? 0).toBeGreaterThanOrEqual(
    (hierarchyMarkerBox?.x ?? 0) + (hierarchyMarkerBox?.width ?? 0)
  )
  expect(
    await workspaceTab.evaluate((tab) => {
      const workspaceName = tab.querySelector('[data-workspace-multiplexer-workspace-name]')
      const projectName = tab.querySelector('[data-workspace-multiplexer-project-name]')
      if (!(workspaceName instanceof HTMLElement) || !(projectName instanceof HTMLElement)) {
        return false
      }
      const workspaceNameRect = workspaceName.getBoundingClientRect()
      const projectNameRect = projectName.getBoundingClientRect()
      return (
        projectNameRect.top >= workspaceNameRect.bottom &&
        Math.abs(projectNameRect.width - workspaceNameRect.width) < 1
      )
    })
  ).toBe(true)
  await expect(tiles.first().locator('.xterm')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (worktreeId) =>
          (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
        activeWorktreeId
      )
    )
    .toEqual(originalTerminalIds)

  await header.getByRole('button', { name: 'Add workspace' }).click()
  const otherWorktreeId = await orcaPage
    .locator('[data-workspace-multiplexer-worktree-id]')
    .evaluateAll(
      (options, currentId) =>
        options
          .find(
            (option) => option.getAttribute('data-workspace-multiplexer-worktree-id') !== currentId
          )
          ?.getAttribute('data-workspace-multiplexer-worktree-id') ?? null,
      activeWorktreeId
    )
  expect(otherWorktreeId).not.toBeNull()
  await orcaPage.keyboard.press('Escape')
  await orcaPage.evaluate((worktreeId) => {
    const store = window.__store!
    const state = store.getState()
    const worktree = state.getKnownWorktreeById(worktreeId!)!
    store.setState({
      worktreesByRepo: {
        ...state.worktreesByRepo,
        [worktree.repoId]: state.worktreesByRepo[worktree.repoId].map((item) =>
          item.id === worktreeId ? { ...item, createdAt: Date.now() } : item
        )
      }
    })
  }, otherWorktreeId)
  await expect(
    orcaPage.getByText('Add new workspaces to Workspace Multiplexer?', { exact: true })
  ).toBeVisible()
  await expect(tiles).toHaveCount(1)
  await orcaPage.getByRole('button', { name: 'Later', exact: true }).click()
  await expect(tiles).toHaveCount(1)
  await orcaPage.evaluate((worktreeId) => {
    window.dispatchEvent(
      new CustomEvent('orca:workspace-multiplexer-add-request', { detail: { worktreeId } })
    )
  }, otherWorktreeId)
  await expect(tiles).toHaveCount(2)
  for (const [index, worktreeId] of [
    [0, activeWorktreeId],
    [1, otherWorktreeId]
  ] as const) {
    await tiles.nth(index).locator('.xterm-screen').first().click()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId))
      .toBe(worktreeId)
  }
  const addedWorkspaceTab = tiles.nth(1).locator('[data-workspace-multiplexer-tab-id]')
  await tiles.first().locator('[data-workspace-multiplexer-tab-id]').click({ button: 'right' })
  await expect(
    orcaPage.getByRole('menuitem', { name: 'Delete worktree…', exact: true })
  ).toHaveCount(0)
  await orcaPage.keyboard.press('Escape')
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({ skipDeleteWorktreeConfirm: true })
  )
  await addedWorkspaceTab.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Delete worktree…', exact: true }).click()
  const tabDeleteDialog = orcaPage.getByRole('dialog')
  await expect(tabDeleteDialog).toBeVisible()
  await expect(tabDeleteDialog.getByRole('checkbox')).toHaveCount(0)
  await orcaPage.screenshot({ path: 'output/playwright/multiplexer-delete-confirm.png' })
  await tabDeleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(addedWorkspaceTab).toBeVisible()
  await expect(
    addedWorkspaceTab.locator('[data-workspace-multiplexer-workspace-icon]')
  ).toBeVisible()
  await expect(addedWorkspaceTab.locator('.lucide-git-branch')).toHaveCount(1)
  await tiles
    .nth(1)
    .getByRole('button', { name: /Remove .* from Workspace Multiplexer/ })
    .press('Enter')
  await expect(tiles).toHaveCount(1)

  for (const direction of ['left', 'up', 'down', 'right'] as const) {
    const originalSlotId = await tiles.first().getAttribute('data-workspace-multiplexer-slot-id')
    await header.getByRole('button', { name: 'Add workspace' }).click()
    const source = orcaPage.locator(
      `[data-workspace-multiplexer-worktree-id=${JSON.stringify(otherWorktreeId)}]`
    )
    const sourceBox = await source.boundingBox()
    const targetBox = await tiles.first().boundingBox()
    if (!sourceBox || !targetBox) {
      throw new Error('Workspace drag endpoints must be visible')
    }
    const x =
      targetBox.x +
      targetBox.width * (direction === 'left' ? 0.05 : direction === 'right' ? 0.95 : 0.5)
    const y =
      targetBox.y +
      (direction === 'up' ? 45 : targetBox.height * (direction === 'down' ? 0.95 : 0.5))
    await orcaPage.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(
      sourceBox.x + sourceBox.width / 2 + 10,
      sourceBox.y + sourceBox.height / 2
    )
    await orcaPage.mouse.move(x, y, { steps: 10 })
    await expect(orcaPage.locator('.tab-drop-overlay')).toBeVisible()
    await orcaPage.screenshot({ path: `output/playwright/multiplexer-drop-${direction}.png` })
    await orcaPage.mouse.move(x, y)
    await orcaPage.mouse.up()
    tiles = orcaPage.locator('[data-workspace-multiplexer-slot-id]')
    await expect(tiles).toHaveCount(2)
    await expect(tiles.locator('.xterm:visible')).toHaveCount(2)
    const original = orcaPage.locator(`[data-workspace-multiplexer-slot-id="${originalSlotId}"]`)
    const added = orcaPage.locator(
      `[data-workspace-multiplexer-slot-id]:not([data-workspace-multiplexer-slot-id="${originalSlotId}"])`
    )
    const originalBox = await original.boundingBox()
    const addedBox = await added.boundingBox()
    if (!originalBox || !addedBox) {
      throw new Error('Split panes must be visible')
    }
    if (direction === 'left') {
      expect(addedBox.x + addedBox.width).toBeLessThanOrEqual(originalBox.x)
    }
    if (direction === 'right') {
      expect(addedBox.x).toBeGreaterThanOrEqual(originalBox.x + originalBox.width)
    }
    if (direction === 'up') {
      expect(addedBox.y + addedBox.height).toBeLessThanOrEqual(originalBox.y)
    }
    if (direction === 'down') {
      expect(addedBox.y).toBeGreaterThanOrEqual(originalBox.y + originalBox.height)
    }
    if (direction !== 'right') {
      await added.getByRole('button', { name: /Remove .* from Workspace Multiplexer/ }).click()
      await expect(tiles).toHaveCount(1)
    }
  }

  const moveSourceBox = await tiles
    .first()
    .locator('[data-workspace-multiplexer-drag-handle]')
    .boundingBox()
  const moveTargetBox = await tiles.nth(1).boundingBox()
  if (!moveSourceBox || !moveTargetBox) {
    throw new Error('Workspace move endpoints must be visible')
  }
  await orcaPage.mouse.move(
    moveSourceBox.x + moveSourceBox.width / 2,
    moveSourceBox.y + moveSourceBox.height / 2
  )
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(
    moveTargetBox.x + moveTargetBox.width - 10,
    moveTargetBox.y + moveTargetBox.height / 2,
    { steps: 10 }
  )
  await expect(orcaPage.locator('.tab-drop-overlay')).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await orcaPage.mouse.up()
  await expect(orcaPage.locator('.tab-drop-overlay')).toHaveCount(0)
  await expect(tiles).toHaveCount(2)
  await orcaPage.mouse.move(
    moveSourceBox.x + moveSourceBox.width / 2,
    moveSourceBox.y + moveSourceBox.height / 2
  )
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(moveSourceBox.x + moveSourceBox.width / 2 + 20, moveSourceBox.y + 4, {
    steps: 4
  })
  await orcaPage.mouse.move(
    moveTargetBox.x + moveTargetBox.width / 2,
    moveTargetBox.y + moveTargetBox.height / 2,
    { steps: 10 }
  )
  await expect(tiles.nth(1)).toHaveAttribute('data-workspace-multiplexer-drop-target', '')
  await orcaPage.mouse.up()
  await expect(tiles).toHaveCount(1)
  let workspaceTabs = orcaPage.locator('[data-workspace-multiplexer-tab-id]')
  await expect(workspaceTabs).toHaveCount(2)
  await expect(tiles.locator('.xterm:visible')).toHaveCount(1)

  await orcaPage.locator('[data-workspace-multiplexer-tab-id][data-active="false"]').click()
  const selectedSlotId = await orcaPage
    .locator('[data-workspace-multiplexer-tab-id][data-active="true"]')
    .getAttribute('data-workspace-multiplexer-tab-id')
  await header.getByRole('button', { name: 'Back', exact: true }).click()
  await trigger.click()
  await expect(
    orcaPage.locator(`[data-workspace-multiplexer-tab-id="${selectedSlotId}"]`)
  ).toHaveAttribute('data-active', 'true')
  await expect(tiles.first()).toHaveClass(/(?:^|\s)ring-1(?:\s|$)/)

  const splitSourceBox = await workspaceTabs.first().boundingBox()
  const splitTargetBox = await tiles.first().boundingBox()
  if (!splitSourceBox || !splitTargetBox) {
    throw new Error('Workspace split endpoints must be visible')
  }
  await orcaPage.mouse.move(
    splitSourceBox.x + splitSourceBox.width / 2,
    splitSourceBox.y + splitSourceBox.height / 2
  )
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(
    splitSourceBox.x + splitSourceBox.width / 2 + 20,
    splitSourceBox.y + 4,
    {
      steps: 4
    }
  )
  await orcaPage.mouse.move(
    splitTargetBox.x + splitTargetBox.width - 4,
    splitTargetBox.y + splitTargetBox.height / 2,
    { steps: 10 }
  )
  await expect(orcaPage.locator('.tab-drop-overlay')).toBeVisible()
  await orcaPage.mouse.up()
  tiles = orcaPage.locator('[data-workspace-multiplexer-pane-id]')
  workspaceTabs = orcaPage.locator('[data-workspace-multiplexer-tab-id]')
  await expect(tiles).toHaveCount(2)
  await expect(workspaceTabs).toHaveCount(2)
  await expect(tiles.locator('.xterm:visible')).toHaveCount(2)

  await tiles.first().getByRole('button', { name: 'Split workspace down' }).click()
  await expect(tiles).toHaveCount(3)
  await expect(tiles.locator('.xterm:visible')).toHaveCount(3)
  await tiles.first().getByRole('button', { name: 'Maximize workspace' }).click()
  await expect(tiles).toHaveCount(1)
  await orcaPage.keyboard.press('Escape')
  await expect(tiles).toHaveCount(3)
  await tiles.first().getByRole('button', { name: 'Maximize workspace' }).click()
  await tiles.first().getByRole('button', { name: 'Split workspace right' }).click()
  await expect(tiles).toHaveCount(4)
  await expect(tiles.locator('.xterm:visible')).toHaveCount(4)
  await orcaPage.screenshot({ path: 'output/playwright/multiplexer-regression.png' })
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const slot = state.workspaceMultiplexer.slots[0]!
    const tab = state.unifiedTabsByWorktree[slot.worktreeId].find(
      (candidate) => candidate.groupId === slot.groupId && candidate.contentType === 'terminal'
    )!
    const leaf = state.terminalLayoutsByTabId[tab.entityId]?.activeLeafId
    if (!leaf) {
      throw new Error('Expected a terminal leaf for completion')
    }
    const key = `${tab.entityId}:${leaf}`
    const now = Date.now()
    state.setAgentStatus(
      key,
      { state: 'working', agentType: 'codex', prompt: 'Animation test' },
      'codex',
      { updatedAt: now, stateStartedAt: now }
    )
    window
      .__store!.getState()
      .setAgentStatus(
        key,
        { state: 'done', agentType: 'codex', prompt: 'Animation test' },
        'codex',
        {
          updatedAt: now + 1,
          stateStartedAt: now + 1
        }
      )
    for (const animation of document.getAnimations()) {
      if (animation.id === 'workspace-multiplexer-completion') {
        animation.pause()
        animation.currentTime = 150
      }
    }
  })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation.id === 'workspace-multiplexer-completion').length
      )
    )
    .toBe(1)
  await orcaPage.screenshot({ path: 'output/playwright/multiplexer-completion.png' })
  await orcaPage.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.id === 'workspace-multiplexer-completion') {
        animation.play()
      }
    }
  })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation.id === 'workspace-multiplexer-completion').length
      )
    )
    .toBe(0)

  const notification = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const slot = state.workspaceMultiplexer.slots.at(-1)!
    const tabId = slot.activeTerminalTabId!
    return {
      slotId: slot.id,
      worktreeId: slot.worktreeId,
      tabId,
      repoId: state.getKnownWorktreeById(slot.worktreeId)!.repoId,
      leafId: state.terminalLayoutsByTabId[tabId].activeLeafId!
    }
  })
  await tiles.first().getByRole('button', { name: 'Maximize workspace' }).click()
  await electronApp.evaluate(({ BrowserWindow }, target) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.send('ui:activateWorktree', { worktreeId: target.worktreeId, repoId: target.repoId })
    contents.send('ui:focusTerminal', {
      ...target,
      ackPaneKeyOnSuccess: `${target.tabId}:${target.leafId}`,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }, notification)
  await expect(orcaPage.locator('[data-workspace-multiplexer-page]')).toBeVisible()
  const notifiedTile = orcaPage.locator(
    `[data-workspace-multiplexer-slot-id="${notification.slotId}"]`
  )
  await expect(notifiedTile).toBeVisible()
  await expect(notifiedTile.locator('.xterm-helper-textarea').first()).toBeFocused()
  await expect
    .poll(() =>
      notifiedTile.evaluate((el) =>
        el.getAnimations().some((animation) => animation.id === 'workspace-multiplexer-completion')
      )
    )
    .toBe(true)
  const deleteSlotId = await orcaPage.evaluate(
    (worktreeId) =>
      window
        .__store!.getState()
        .workspaceMultiplexer.slots.find((slot) => slot.worktreeId === worktreeId)?.id,
    otherWorktreeId
  )
  expect(deleteSlotId).toBeTruthy()
  const deleteTab = orcaPage.locator(`[data-workspace-multiplexer-tab-id="${deleteSlotId}"]`)
  await deleteTab.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Delete worktree…', exact: true }).click()
  await expect(orcaPage.getByRole('dialog')).toBeVisible()
  await orcaPage
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete Workspace', exact: true })
    .click()
  await expect(deleteTab).toHaveCount(0, { timeout: 30_000 })
  await expect(orcaPage.locator('[data-workspace-multiplexer-page]')).toBeVisible()
})
