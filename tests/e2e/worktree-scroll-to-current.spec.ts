import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const WORKTREE_OPTION_PREFIX = 'worktree-list-option-'

function worktreeOption(page: Page, worktreeId: string) {
  return page.locator(`[id="${WORKTREE_OPTION_PREFIX}${encodeURIComponent(worktreeId)}"]`)
}

async function prepareSidebarForScrollTest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('recent')
    state.setShowActiveOnly(false)
    state.setShowSleepingWorkspaces(true)
    state.setHideDefaultBranchWorkspace(false)
    state.setFilterRepoIds([])
  })
}

async function forceCurrentWorkspaceClipped(page: Page, targetId: string): Promise<void> {
  await page.locator('[data-worktree-sidebar]').evaluate((element, targetId) => {
    const scroller = element as HTMLElement
    const target = document.getElementById(`worktree-list-option-${encodeURIComponent(targetId)}`)
    if (!target) {
      throw new Error('Target workspace row is not mounted')
    }

    scroller.style.height = '72px'
    scroller.style.maxHeight = '72px'
    scroller.style.overflowY = 'auto'

    const scrollerBounds = scroller.getBoundingClientRect()
    const targetBounds = target.getBoundingClientRect()
    const desiredTargetTop = scrollerBounds.bottom - 24
    scroller.scrollTop += targetBounds.top - desiredTargetTop
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    window.dispatchEvent(new Event('resize'))
  }, targetId)

  await expect
    .poll(
      () =>
        page.evaluate((targetId) => {
          const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
          const target = document.getElementById(
            `worktree-list-option-${encodeURIComponent(targetId)}`
          )
          if (!scroller || !target) {
            return false
          }

          const scrollerBounds = scroller.getBoundingClientRect()
          const targetBounds = target.getBoundingClientRect()
          return (
            targetBounds.top < scrollerBounds.bottom && targetBounds.bottom > scrollerBounds.bottom
          )
        }, targetId),
      {
        timeout: 10_000,
        message: 'Target workspace should be clipped before using the reveal button'
      }
    )
    .toBe(true)
}

async function expectNoRevealHighlightDuring(
  page: Page,
  targetId: string,
  durationMs: number
): Promise<void> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    const isHighlighted = await page.evaluate((targetId) => {
      const target = document.getElementById(`worktree-list-option-${encodeURIComponent(targetId)}`)
      return target?.getAttribute('data-scroll-reveal-highlight') === 'true'
    }, targetId)
    expect(isHighlighted).toBe(false)
    await page.waitForTimeout(50)
  }
}

test.describe('Reveal active workspace button', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('reveals the current workspace when it is clipped in the production sidebar', async ({
    orcaPage
  }) => {
    await prepareSidebarForScrollTest(orcaPage)

    const renderedOptions = orcaPage.locator('[data-worktree-sidebar] [role="option"]')
    await expect(renderedOptions).toHaveCount(2)

    const targetIdAttribute = await renderedOptions.last().getAttribute('id')
    if (!targetIdAttribute?.startsWith(WORKTREE_OPTION_PREFIX)) {
      throw new Error('Bottom workspace row did not expose the expected option id')
    }

    const targetId = decodeURIComponent(targetIdAttribute.slice(WORKTREE_OPTION_PREFIX.length))
    const targetRow = worktreeOption(orcaPage, targetId)
    const revealButton = orcaPage.getByRole('button', { name: 'Reveal active workspace' })

    await renderedOptions.last().click()
    await expect(targetRow).toHaveAttribute('aria-current', 'page')
    await expectNoRevealHighlightDuring(orcaPage, targetId, 400)
    await expect(revealButton).toBeVisible()
    await expect(revealButton).toBeEnabled()
    await forceCurrentWorkspaceClipped(orcaPage, targetId)

    await expect(revealButton).toBeVisible()
    await expect(revealButton).toBeEnabled()

    await revealButton.click()
    await expect(targetRow).toHaveAttribute('data-scroll-reveal-highlight', 'true')

    await expect
      .poll(
        () =>
          orcaPage.evaluate((targetId) => {
            const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
            const target = document.getElementById(
              `worktree-list-option-${encodeURIComponent(targetId)}`
            )
            if (!scroller || !target) {
              return false
            }

            const scrollerBounds = scroller.getBoundingClientRect()
            const targetBounds = target.getBoundingClientRect()
            return (
              targetBounds.top >= scrollerBounds.top - 1 &&
              targetBounds.bottom <= scrollerBounds.bottom + 1
            )
          }, targetId),
        {
          timeout: 10_000,
          message: 'Reveal button did not scroll the current workspace fully into view'
        }
      )
      .toBe(true)
    await expect(revealButton).toBeVisible()
    await expect(revealButton).toBeEnabled()
  })

  test('clears sidebar filters before revealing a hidden current workspace', async ({
    orcaPage
  }) => {
    await prepareSidebarForScrollTest(orcaPage)

    const renderedOptions = orcaPage.locator('[data-worktree-sidebar] [role="option"]')
    await expect(renderedOptions).toHaveCount(2)

    const targetIdAttribute = await renderedOptions.last().getAttribute('id')
    if (!targetIdAttribute?.startsWith(WORKTREE_OPTION_PREFIX)) {
      throw new Error('Bottom workspace row did not expose the expected option id')
    }

    const targetId = decodeURIComponent(targetIdAttribute.slice(WORKTREE_OPTION_PREFIX.length))
    const targetRow = worktreeOption(orcaPage, targetId)
    const revealButton = orcaPage.getByRole('button', { name: 'Reveal active workspace' })

    await renderedOptions.last().click()
    await expect(targetRow).toHaveAttribute('aria-current', 'page')

    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().setFilterRepoIds(['__filtered_repo__'])
    })

    await expect(renderedOptions).toHaveCount(0)
    await expect(orcaPage.getByText('No workspaces found')).toBeVisible()

    await revealButton.click()

    await expect(targetRow).toBeVisible()
    await expect(targetRow).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            return store.getState().filterRepoIds
          }),
        {
          timeout: 10_000,
          message: 'Reveal button should clear repo filters that hide the current workspace'
        }
      )
      .toEqual([])
  })
})
