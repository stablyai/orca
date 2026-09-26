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
  await expect(target.getByRole('textbox')).toBeInViewport()
  await expect(target).not.toHaveAttribute('data-scroll-reveal-highlight', 'true')
  await writeFile(
    testInfo.outputPath('interrupted-rename.json'),
    JSON.stringify(
      await target.evaluate((element) => {
        const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
        return {
          top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
          scrollTop: scroller.scrollTop
        }
      })
    )
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('interrupted-rename.png') })
})
