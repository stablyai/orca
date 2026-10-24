import { expect, test } from './helpers/orca-app'

test.afterEach(async ({ electronApp }) => {
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})

for (const view of ['workspace', 'landing', 'tasks'] as const) {
  for (const width of [1100, 1921]) {
    test(`board fills the center with the sidebar hidden on ${view} at ${width}px`, async ({
      orcaPage: page,
      electronApp
    }) => {
      await electronApp.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0].setSize(width, 1000)
      }, width)
      await page.evaluate(
        async ({ view, width }) => {
          const state = window.__store!.getState()
          await state.setKeybindingOverride('workspace.openBoard', ['Mod+Alt+K'])
          state.setSidebarWidth(320)
          state.setSidebarOpen(true)
          state.setRightSidebarOpen(true)
          state.setRightSidebarWidth(350)
          if (view === 'workspace' && width === 1921) {
            state.setWorkspaceStatuses(state.workspaceStatuses.slice(0, 3))
          }
          if (view === 'landing') {
            state.setActiveWorktree(null)
          }
          if (view === 'tasks') {
            state.setActiveView('tasks')
          }
        },
        { view, width }
      )
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+k' : 'Control+Alt+k')
      const board = page.locator('[data-workspace-board-sheet]')
      await expect(board).toBeVisible()
      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => window.__store!.getState().sidebarOpen))
        .toBe(false)

      const rightSidebar = page
        .getByRole('button', { name: 'Toggle right sidebar', exact: true })
        .last()
      const rightSidebarRect = () =>
        rightSidebar.evaluate((button) => {
          const rect = button.closest('.relative.flex-shrink-0')?.getBoundingClientRect()
          if (!rect) {
            throw new Error('Right sidebar is missing')
          }
          return { left: rect.left, width: rect.width }
        })
      const centerGap = async () => {
        const centerRight = (await rightSidebar.count())
          ? (await rightSidebarRect()).left
          : await page.evaluate(() => window.innerWidth)
        return board.evaluate(
          (element, centerRight) => Math.round(centerRight - element.getBoundingClientRect().right),
          centerRight
        )
      }
      await expect.poll(centerGap).toBe(0)
      const columnWidthError = () =>
        board.locator('[data-workspace-board-lane-grid]').evaluate((grid) => {
          const viewport = grid.parentElement!
          const lanes = Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-index]'))
          const state = window.__store!.getState()
          const count = state.workspaceStatuses.length
          const fittedWidth = (viewport.clientWidth - (count - 1) * 12) / count
          const expectedWidth = Math.max(state.workspaceBoardColumnWidth, fittedWidth)
          const viewportRect = viewport.getBoundingClientRect()
          const errors = lanes.flatMap((lane) => {
            const rect = lane.getBoundingClientRect()
            const expectedLeft =
              viewportRect.left +
              Number(lane.dataset.index) * (expectedWidth + 12) -
              viewport.scrollLeft
            return [Math.abs(rect.width - expectedWidth), Math.abs(rect.left - expectedLeft)]
          })
          if (fittedWidth >= state.workspaceBoardColumnWidth) {
            const lastLane = lanes.find((lane) => Number(lane.dataset.index) === count - 1)
            if (!lastLane) {
              throw new Error('Last board column is missing despite fitting in the viewport')
            }
            errors.push(Math.abs(lastLane.getBoundingClientRect().right - viewportRect.right))
          }
          return Math.max(...errors)
        })
      await expect.poll(columnWidthError).toBeLessThan(0.1)
      expect(await page.evaluate(() => window.__store!.getState().workspaceBoardColumnWidth)).toBe(
        308
      )
      await expect
        .poll(() => board.evaluate((element) => Math.round(element.getBoundingClientRect().left)))
        .toBe(0)

      await electronApp.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0].setSize(width === 1921 ? 1100 : 1921, 1000)
      }, width)
      await expect.poll(centerGap).toBe(0)
      await expect.poll(columnWidthError).toBeLessThan(0.1)

      if (view !== 'tasks') {
        const rightEdge = (await rightSidebarRect()).left
        await page.mouse.move(rightEdge + 2, 10)
        await page.mouse.down()
        await page.mouse.move(rightEdge - 50, 10)
        await expect.poll(async () => (await rightSidebarRect()).width).toBeGreaterThan(350)
        await expect.poll(centerGap).toBe(0)
        await expect.poll(columnWidthError).toBeLessThan(0.1)
        expect(await page.evaluate(() => window.__store!.getState().rightSidebarWidth)).toBe(350)
        await page.mouse.up()
        await expect
          .poll(() => page.evaluate(() => window.__store!.getState().rightSidebarWidth))
          .toBeGreaterThan(350)
        const panelWidth = await page.evaluate(() => window.__store!.getState().rightSidebarWidth)
        await page.evaluate(() => window.__store!.getState().setActivityBarPosition('side'))
        await expect.poll(async () => (await rightSidebarRect()).width).toBe(panelWidth + 40)
        await expect.poll(centerGap).toBe(0)
        await expect.poll(columnWidthError).toBeLessThan(0.1)
        await rightSidebar.click()
        await expect
          .poll(() => page.evaluate(() => window.__store!.getState().rightSidebarOpen))
          .toBe(false)
        await expect
          .poll(() =>
            board.evaluate((element) =>
              Math.round(window.innerWidth - element.getBoundingClientRect().right)
            )
          )
          .toBe(0)
        await expect.poll(columnWidthError).toBeLessThan(0.1)
      }

      await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
      await expect
        .poll(() => board.evaluate((element) => Math.round(element.getBoundingClientRect().left)))
        .toBe(320)
      await expect
        .poll(() => board.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
        .toBe(await page.evaluate(() => Math.min(window.innerWidth - 320, 1294)))
      await page.keyboard.press('Escape')
      await expect(board).toHaveCount(0)
    })
  }
}

test('menu board command preserves sidebar visibility and ignores settings', async ({
  orcaPage: page,
  electronApp
}) => {
  const board = page.locator('[data-workspace-board-sheet]')
  for (const sidebarOpen of [false, true]) {
    await page.evaluate(
      (sidebarOpen) => window.__store!.getState().setSidebarOpen(sidebarOpen),
      sidebarOpen
    )
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('ui:openWorkspaceBoard')
    })
    await expect(board).toBeVisible()
    expect(await page.evaluate(() => window.__store!.getState().sidebarOpen)).toBe(sidebarOpen)
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('ui:openWorkspaceBoard')
    })
    await expect(board).toHaveCount(0)
    expect(await page.evaluate(() => window.__store!.getState().sidebarOpen)).toBe(sidebarOpen)
  }
  await page.evaluate(() => window.__store!.getState().setActiveView('settings'))
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('ui:openWorkspaceBoard')
  })
  await expect(board).toHaveCount(0)
})
