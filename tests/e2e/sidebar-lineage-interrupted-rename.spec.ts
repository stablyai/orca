import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

test('rename-current-workspace survives wheel input during smooth reveal', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { targetId } = await seedVirtualLineage(orcaPage, false)
  await orcaPage.evaluate((targetId) => {
    window.__store!.setState((state) => ({
      activeWorktreeId: targetId,
      activeWorkspaceKey: `worktree:${targetId}`,
      pendingRevealWorktree: null,
      keybindings: { ...state.keybindings, 'workspace.rename': ['Mod+Alt+R'] }
    }))
  }, targetId)
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  const scroller = orcaPage.locator('[data-worktree-sidebar]')
  await scroller.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }))
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await orcaPage.waitForTimeout(650)
  await orcaPage.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
    scroller.addEventListener(
      'scroll',
      () => {
        scroller.dataset.renameInterruptedAt = String(scroller.scrollTop)
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }))
      },
      { once: true }
    )
  })
  await orcaPage.keyboard.press('ControlOrMeta+Alt+r')
  await expect(scroller).toHaveAttribute('data-rename-interrupted-at', /[1-9]/)
  const target = worktreeRow(orcaPage, targetId)
  await expect(target.getByRole('textbox')).toHaveValue('Virtual child 400')
  const geometry = () =>
    target.evaluate((element) => {
      const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
      const containerTop = scroller.getBoundingClientRect().top
      const input = element.querySelector<HTMLInputElement>('[data-worktree-title-rename-input]')
      const inputBounds = input?.getBoundingClientRect()
      return {
        top: element.getBoundingClientRect().top - containerTop,
        inputTop: inputBounds ? inputBounds.top - containerTop : null,
        inputBottom: inputBounds ? inputBounds.bottom - containerTop : null,
        inputFocused: document.activeElement === input,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        viewportHeight: scroller.clientHeight,
        interruptedAt: scroller.dataset.renameInterruptedAt
      }
    })
  await writeFile(
    testInfo.outputPath('interrupted-rename-before-visibility.json'),
    JSON.stringify(await geometry(), null, 2)
  )
  try {
    await expect(target.getByRole('textbox')).toBeInViewport()
    await expect(target).not.toHaveAttribute('data-scroll-reveal-highlight', 'true')
  } finally {
    await writeFile(
      testInfo.outputPath('interrupted-rename.json'),
      JSON.stringify(await geometry(), null, 2)
    )
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('interrupted-rename.png') })
})
