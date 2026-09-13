/**
 * E2E: Go to Definition (Cmd+B) drives the real Electron app.
 *
 * User-facing guarantee: with the cursor on a symbol in the editor, Cmd+B jumps
 * to the file where that symbol is defined, opening it at the definition line.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getOpenFiles
} from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import { TEST_REPO_PATH_FILE } from './global-setup'

function seedRoot(): string {
  return realpathSync(readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim())
}

test.describe('Go to Definition (Cmd+B)', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('Cmd+B on a symbol jumps to its definition file at the definition line', async ({
    orcaPage
  }) => {
    const root = seedRoot()
    // Unique symbol with exactly ONE definition, referenced from another file.
    writeFileSync(
      path.join(root, 'src', 'def.ts'),
      'export function uniqueTargetE2E() {\n  return 123\n}\n'
    )
    writeFileSync(path.join(root, 'src', 'use.ts'), 'uniqueTargetE2E()\n')

    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Deterministically build the index up front (real preload bridge) so the
    // single Cmd+B resolves 'ready' instead of the first-query 'indexing' path.
    await orcaPage.evaluate(
      async ({ wid, wroot }) => {
        await window.api.symbolIndex.ensureIndexed({ worktreeId: wid, worktreeRoot: wroot })
      },
      { wid: worktreeId, wroot: root }
    )

    // Open the referencing file in the editor via the real store action.
    await orcaPage.evaluate(
      ({ wid, filePath }) => {
        const store = window.__store
        if (!store) {
          return
        }
        const state = store.getState()
        state.openFile({
          filePath,
          relativePath: 'src/use.ts',
          worktreeId: wid,
          language: 'typescript',
          mode: 'edit'
        })
        state.setActiveTabType('editor')
      },
      { wid: worktreeId, filePath: path.join(root, 'src', 'use.ts') }
    )

    // Editor (lazy chunk) must actually paint use.ts before we interact.
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText('use.ts', {
      timeout: 25_000
    })

    // Double-click INSIDE the identifier text (not the line's full-width
    // center, which lands past the short text and yields no word-at-cursor) to
    // focus Monaco and select the symbol so extraction returns it.
    await orcaPage
      .locator('.view-line', { hasText: 'uniqueTargetE2E' })
      .first()
      .dblclick({ position: { x: 25, y: 8 } })

    await pressShortcut(orcaPage, 'B')

    // The feature opens the definition file and reveals its line. Assert a new
    // editor tab for def.ts exists and the editor header shows it.
    await expect
      .poll(
        async () => {
          const files = await getOpenFiles(orcaPage, worktreeId)
          return files.some((f) => f.filePath.endsWith(path.join('src', 'def.ts')))
        },
        { timeout: 15_000 }
      )
      .toBe(true)

    await expect(orcaPage.locator('.editor-header-path').first()).toContainText('def.ts', {
      timeout: 15_000
    })
  })

  test('Cmd+B on an undefined symbol does not crash and opens no definition tab', async ({
    orcaPage
  }) => {
    const root = seedRoot()
    writeFileSync(path.join(root, 'src', 'lonely.ts'), 'noSuchSymbolAnywhereE2E\n')
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    await orcaPage.evaluate(
      async ({ wid, wroot }) => {
        await window.api.symbolIndex.ensureIndexed({ worktreeId: wid, worktreeRoot: wroot })
      },
      { wid: worktreeId, wroot: root }
    )
    await orcaPage.evaluate(
      ({ wid, filePath }) => {
        const store = window.__store
        if (!store) {
          return
        }
        const state = store.getState()
        state.openFile({
          filePath,
          relativePath: 'src/lonely.ts',
          worktreeId: wid,
          language: 'typescript',
          mode: 'edit'
        })
        state.setActiveTabType('editor')
      },
      { wid: worktreeId, filePath: path.join(root, 'src', 'lonely.ts') }
    )
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText('lonely.ts', {
      timeout: 25_000
    })

    await orcaPage
      .locator('.view-line', { hasText: 'noSuchSymbolAnywhereE2E' })
      .first()
      .dblclick({ position: { x: 25, y: 8 } })
    await pressShortcut(orcaPage, 'B')

    // No definition exists -> the app must not open a definition tab for it and
    // must stay responsive (the active editor is still lonely.ts).
    await orcaPage.waitForTimeout(1_500)
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText('lonely.ts')
  })
})
