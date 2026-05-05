/**
 * E2E test for the saved-note "Delete" button inside a diff view.
 *
 * Why: the saved note card (DiffCommentCard) is rendered into a Monaco view
 * zone. Monaco routes mouse events to the editor by default, so the delete
 * button relies on `suppressMouseDown: false` plus per-element
 * stopPropagation handlers in `useDiffCommentDecorator.tsx`. A regression
 * anywhere in that chain (e.g. flipping suppressMouseDown, adding an
 * overlay that eats pointer events, removing the always-visible styling)
 * would make the button uninteractive with no type-check or unit-test
 * signal — this spec is the guard.
 *
 * The test seeds a DiffComment directly through the renderer store so it
 * does not depend on the hover-to-"+" affordance working, which is a
 * separate interaction path. It then opens the diff tab that will display
 * the saved note's view zone, clicks the trash button, and asserts the
 * store list is empty and the DOM zone is gone.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test.describe('Diff note delete', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('clicking the trash button removes the saved note', async ({ orcaPage }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)

    // Why: modify a tracked file so opening a diff shows real added/removed
    // content rather than an empty "no changes" state. `src/index.ts` is
    // seeded by global-setup with a single line, so rewriting it produces a
    // diff the modified Monaco editor will render against.
    const { relativePath } = await orcaPage.evaluate(async (wId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available — is the app in dev mode?')
      }
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        throw new Error('active worktree not found')
      }
      const separator = worktree.path.includes('\\') ? '\\' : '/'
      const rel = `src${separator}index.ts`
      const absolutePath = `${worktree.path}${separator}${rel}`
      await window.api.fs.writeFile({
        filePath: absolutePath,
        content: 'export const hello = "note-test"\n'
      })
      return { relativePath: rel }
    }, worktreeId)

    // Seed a diff comment directly through the store. This avoids depending
    // on the hover-to-"+" interaction (a separate code path) so this spec
    // stays focused on the delete affordance.
    const addResult = await orcaPage.evaluate(
      async ({ wId, rel }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const comment = await store.getState().addDiffComment({
          worktreeId: wId,
          filePath: rel,
          lineNumber: 1,
          body: 'delete-me note',
          side: 'modified'
        })
        return comment
      },
      { wId: worktreeId, rel: relativePath }
    )
    expect(addResult, 'addDiffComment returned null').not.toBeNull()
    const commentId = addResult!.id

    // Open the diff tab for this file so the decorator mounts a view zone
    // for the seeded note.
    await orcaPage.evaluate(
      ({ wId, rel }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        const state = store.getState()
        const worktree = Object.values(state.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === wId)
        if (!worktree) {
          throw new Error('active worktree not found')
        }
        const separator = worktree.path.includes('\\') ? '\\' : '/'
        state.openDiff(wId, `${worktree.path}${separator}${rel}`, rel, 'typescript', false)
      },
      { wId: worktreeId, rel: relativePath }
    )

    // The note card is rendered into a Monaco view zone. Wait for the
    // trash button itself rather than any parent container so we know the
    // React root inside the zone has actually mounted.
    const deleteButton = orcaPage.locator('.orca-diff-comment-delete').first()
    await expect(deleteButton).toBeVisible({ timeout: 15_000 })

    await deleteButton.click()

    // Store must drop the comment …
    await expect
      .poll(
        async () =>
          orcaPage.evaluate((id: string) => {
            const store = window.__store
            if (!store) {
              return null
            }
            const all = Object.values(store.getState().worktreesByRepo)
              .flat()
              .flatMap((w) => w.diffComments ?? [])
            return all.some((c) => c.id === id)
          }, commentId),
        {
          timeout: 5_000,
          message: 'deleteDiffComment did not remove the comment from the store'
        }
      )
      .toBe(false)

    // …and the view zone must be unmounted, proving the click actually
    // reached the React handler (not just some other listener that
    // happened to mutate the store).
    await expect(orcaPage.locator('.orca-diff-comment-delete')).toHaveCount(0, {
      timeout: 5_000
    })
  })
})
