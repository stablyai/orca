/**
 * E2E tests for the "Create Workspace" flow in Orca.
 *
 * Why: the old 'create-worktree' modal was replaced by the composer modal
 * (`activeModal === 'new-workspace-composer'`) in #710. A prior version of
 * this spec bypassed the UI entirely — it called `state.createWorktree(...)`
 * directly on the store — which is why the #1186 regression (a React #31
 * crash when `StartFromField` rendered the new `getBaseRefDefault` envelope
 * as JSX) shipped despite a green suite.
 *
 * The spec now drives the real user flow: open the composer, expand
 * Advanced (so StartFromField mounts and exercises the crash path), type a
 * workspace name, click Create, and assert the worktree actually
 * materialized and became active. See `tests/e2e/AGENTS.md` for the rule
 * that E2E assertions must target the DOM, not the store.
 */

import type { ConsoleMessage } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  ensureTerminalVisible,
  worktreeExists
} from './helpers/store'

test.describe('Create Workspace', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('creates a worktree through the composer UI and activates it', async ({ orcaPage }) => {
    const worktreeIdBefore = await getActiveWorktreeId(orcaPage)

    // Capture render errors for the #1186 guard. React logs "Objects are not
    // valid as a React child" via console.error before throwing the
    // minified-production error #31; capture both paths so the test fails
    // loudly whether the build is dev or prod.
    const pageErrors: Error[] = []
    orcaPage.on('pageerror', (err) => {
      pageErrors.push(err)
    })
    const consoleErrors: string[] = []
    const onConsole = (msg: ConsoleMessage): void => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    }
    orcaPage.on('console', onConsole)

    const workspaceName = `e2e-create-${Date.now()}`

    try {
      // 1. Open the composer. Using the store setter (not clicking the
      // sidebar affordance) keeps the spec stable under sidebar refactors;
      // the modal open path itself is not what #1186 broke.
      await orcaPage.evaluate(() => {
        window.__store?.getState().openModal('new-workspace-composer')
      })

      const dialog = orcaPage.getByRole('dialog', { name: /Create Workspace/i })
      await expect(dialog).toBeVisible()

      // Wait for the composer to settle. The card fires several async effects
      // on mount (detected-agent probe, repo combobox autofocus + hydration,
      // setup-hooks fetch). Clicking before those settle can race Radix's
      // FocusScope reparenting and leaves the Advanced button detached.
      await expect(dialog.getByRole('combobox').first()).toBeVisible()

      // 2. Expand Advanced so StartFromField mounts. In the collapsed state
      // the drawer is `aria-hidden` and StartFromField is not in the DOM at
      // all, so the #1186 crash path cannot be exercised until after this.
      //
      // Why `force: true`: the button is visible and enabled, but the
      // composer can still be mid-flush from a late-resolving effect. The
      // real user hits the same button; force skips Playwright's stability
      // retry loop, which otherwise races with Radix's focus management.
      await dialog.getByRole('button', { name: /Advanced/i }).click({ force: true })

      const startFromTrigger = dialog
        .locator('label', { hasText: 'Start from' })
        .locator('..')
        .getByRole('button')
        .first()
      await expect(startFromTrigger).toBeVisible()

      // Force the `getBaseRefDefault` IPC to round-trip, then give React a
      // frame to commit. Before this settles the trigger shows the fallback
      // "Default branch" label, which masks the #1186 regression — the
      // crash only fires on the render after the envelope lands in state.
      await orcaPage.evaluate(async () => {
        const repoId = Object.values(window.__store!.getState().worktreesByRepo).flat()[0]?.repoId
        if (!repoId) {
          return
        }
        await window.api.repos.getBaseRefDefault({ repoId })
      })
      await orcaPage.waitForTimeout(100)

      // Post-IPC assertion: the StartFromField subtree must still be mounted.
      // Under the #1186 bug, React throws when rendering the envelope object
      // as a child and unmounts the popover trigger — so `toBeVisible` is
      // the tight regression guard here, not a liveness check.
      await expect(startFromTrigger).toBeVisible()
      await expect(startFromTrigger).not.toHaveText('')
      await expect(startFromTrigger).not.toContainText('[object')

      // 3. Type the workspace name into the Name input. This is what lets
      // the composer pass its `workspaceName` guard inside submitQuick.
      const nameInput = dialog.getByPlaceholder(/Workspace name/i)
      await expect(nameInput).toBeVisible()
      await nameInput.fill(workspaceName)

      // 4. Click Create Workspace. This fires the full submitQuick path:
      // createWorktree IPC, applyWorktreeMeta, activateAndRevealWorktree,
      // and closeModal via onCreated.
      const createButton = dialog.getByRole('button', { name: /Create Workspace/i })
      await expect(createButton).toBeEnabled()
      await createButton.click()

      // 5. The modal closes once submitQuick completes successfully. If
      // something inside the flow threw (IPC failure, hook error), the modal
      // would stay open with a createError banner — catch that as a fail.
      await expect(dialog).toBeHidden({ timeout: 15_000 })

      // 6. The new worktree must actually exist on disk and in the store.
      await expect
        .poll(async () => worktreeExists(orcaPage, workspaceName), {
          timeout: 10_000,
          message: `Worktree "${workspaceName}" did not appear in the store`
        })
        .toBe(true)

      // 7. The new worktree must become active (different from whatever was
      // active before we opened the composer).
      await expect
        .poll(
          async () => {
            const id = await getActiveWorktreeId(orcaPage)
            return id !== null && id !== worktreeIdBefore
          },
          { timeout: 10_000, message: 'New worktree did not become the active worktree' }
        )
        .toBe(true)

      // 8. A terminal tab must auto-create for the new worktree. This is
      // the downstream signal that `activateAndRevealWorktree` actually
      // fired, not just that the store row exists.
      await ensureTerminalVisible(orcaPage)

      // Final render-error sweep. Any render crash during the flow (whether
      // it tore down the modal or bubbled past it) shows up here.
      expect(pageErrors, `pageerror fired: ${pageErrors.map((e) => e.message).join(', ')}`).toEqual(
        []
      )
      const reactChildErrors = consoleErrors.filter((text) =>
        /Objects are not valid as a React child|Minified React error #31/i.test(text)
      )
      expect(reactChildErrors, `React render error: ${reactChildErrors.join(', ')}`).toEqual([])
    } finally {
      orcaPage.off('console', onConsole)
      // Best-effort close if the test failed mid-flow and left the modal open.
      await orcaPage
        .evaluate(() => {
          window.__store?.getState().closeModal()
        })
        .catch(() => {
          /* page may already be torn down */
        })
    }
  })
})
