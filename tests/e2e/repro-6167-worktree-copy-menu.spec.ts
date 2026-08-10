import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRowSurface } from './worktree-row-locators'

// Repro capture for #6167: the Copy items on the worktree row context menu.
// Set ORCA_CAPTURE_EVIDENCE=1 to also write a menu screenshot to pr-evidence/
// (gitignored). Off by default so CI just runs the behavioral assertion.
test('captures the worktree context menu Copy items (#6167)', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  const surface = worktreeRowSurface(orcaPage, worktreeId)
  await expect(surface).toBeVisible()
  await surface.click({ button: 'right' })

  const menu = orcaPage.locator('[role="menu"]').first()
  await expect(menu).toBeVisible()

  const labels = await menu.locator('[role="menuitem"]').allInnerTexts()
  const copyItems = labels.filter((label) => label.toLowerCase().includes('copy'))
  await test.info().attach('menu-items.json', {
    body: JSON.stringify({ menuItems: labels, copyItems }, null, 2),
    contentType: 'application/json'
  })

  if (process.env.ORCA_CAPTURE_EVIDENCE === '1') {
    const outputDir = resolve(process.cwd(), 'pr-evidence')
    mkdirSync(outputDir, { recursive: true })
    await menu.screenshot({ path: resolve(outputDir, 'worktree-context-menu-head.png') })
  }

  // Requested behavior: Copy path + Copy branch name + Copy PR URL.
  expect(copyItems.length).toBeGreaterThanOrEqual(3)
})
