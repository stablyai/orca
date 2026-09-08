import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('shows selected workspace terminals in Workspace Multiplexer', async ({ orcaPage }) => {
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
    window.dispatchEvent(
      new CustomEvent('orca:workspace-multiplexer-add-request', { detail: { worktreeId } })
    )
  }, otherWorktreeId)
  await expect(tiles).toHaveCount(2)
  const addedWorkspaceTab = tiles.nth(1).locator('[data-workspace-multiplexer-tab-id]')
  await expect(
    addedWorkspaceTab.locator('[data-workspace-multiplexer-workspace-icon]')
  ).toBeVisible()
  await expect(addedWorkspaceTab.locator('.lucide-git-branch')).toHaveCount(1)
  await tiles
    .nth(1)
    .getByRole('button', { name: /Remove .* from Workspace Multiplexer/ })
    .click()
  await expect(tiles).toHaveCount(1)

  await header.getByRole('button', { name: 'Add workspace' }).click()
  const source = orcaPage.locator(
    `[data-workspace-multiplexer-worktree-id=${JSON.stringify(otherWorktreeId)}]`
  )
  const sourceBox = await source.boundingBox()
  const targetBox = await tiles.first().boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('Workspace drag endpoints must be visible')
  }
  await orcaPage.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 10,
    sourceBox.y + sourceBox.height / 2
  )
  await orcaPage.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 10
  })
  await expect(orcaPage.locator('[data-workspace-multiplexer-page]')).toHaveAttribute(
    'data-workspace-multiplexer-drag-over',
    ''
  )
  await orcaPage.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
  await orcaPage.mouse.up()
  tiles = orcaPage.locator('[data-workspace-multiplexer-slot-id]')
  await expect(tiles).toHaveCount(2)
  await expect(tiles.locator('.xterm:visible')).toHaveCount(2)

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
})
