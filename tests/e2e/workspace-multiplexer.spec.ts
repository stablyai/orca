import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('shows selected workspace terminals in Workspace Multiplexer', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ uiLanguage: 'en' }))
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

  const trigger = orcaPage.locator('[data-workspace-multiplexer-trigger]')
  await expect(trigger).toHaveAttribute('aria-label', 'Workspace Multiplexer')
  await trigger.click()
  await expect(orcaPage.locator('[data-workspace-multiplexer-page]')).toBeVisible()
  await expect(orcaPage.locator('[data-floating-terminal-toggle]')).toHaveCount(0)

  const header = orcaPage.locator('[data-workspace-multiplexer-page] > header')
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
  await activeOption.click()

  let tiles = orcaPage.locator('[data-workspace-multiplexer-slot-id]')
  await expect(tiles).toHaveCount(1)
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
