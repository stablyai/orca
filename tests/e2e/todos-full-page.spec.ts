import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const TODO_BODY = 'Full page todo'
const PAGE_MARKDOWN = [
  '## Plan',
  '',
  '- top',
  '  - nested',
  '',
  'See [docs](https://example.com)'
].join('\n')
const UPDATE_BODY = 'Kicked off the work'

async function openTodos(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const state = window.__store?.getState()
    state?.setActiveWorktree(targetWorktreeId)
    state?.setRightSidebarOpen(true)
  }, worktreeId)
  // Why: the click mounts the panel; the tab occasionally reverts to 'explorer'
  // as the sidebar settles, so wait for the button, then re-open + re-apply
  // 'todos' through the store each poll iteration until it sticks (store-driven
  // correction per flaky-nav guidance), and finally wait for the panel itself.
  const todosButton = page.getByRole('button', { name: 'Todos' }).first()
  await todosButton.waitFor({ state: 'visible', timeout: 10_000 })
  await todosButton.click()
  await expect
    .poll(
      async () => {
        const tab = await page.evaluate(() => window.__store?.getState().rightSidebarTab)
        if (tab !== 'todos') {
          await page.evaluate(() => {
            const state = window.__store?.getState()
            state?.setRightSidebarOpen(true)
            state?.setRightSidebarTab('todos')
          })
        }
        return tab
      },
      { timeout: 8_000 }
    )
    .toBe('todos')
  await expect(page.getByTestId('todo-section-worktree')).toBeVisible({ timeout: 10_000 })
}

async function addTodo(page: Page): Promise<void> {
  const section = page.getByTestId('todo-section-worktree')
  await expect(section).toBeVisible({ timeout: 10_000 })
  const input = section.getByPlaceholder('Add a todo')
  await input.fill(TODO_BODY)
  await input.press('Enter')
  await expect(section.getByTestId('todo-row').filter({ hasText: TODO_BODY })).toBeVisible()
}

test.describe('Todo full page view', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('opens the full page with the real markdown editor, edits, and persists', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await openTodos(orcaPage, worktreeId)
    await addTodo(orcaPage)

    // Seed the page markdown via the store so the rich editor mounts with real
    // content (headings, a sub-list, a link) — deterministic vs. typing markdown
    // into a WYSIWYG editor.
    const todoId = await orcaPage.evaluate((wt) => {
      const list = window.__store?.getState().getTodos('worktree', wt) ?? []
      return list.find((t) => t.body === 'Full page todo')?.id ?? null
    }, worktreeId)
    expect(todoId).toBeTruthy()
    await orcaPage.evaluate(
      ({ wt, id, body }) => {
        window.__store?.getState().setTodoNotesDoc('worktree', wt, id, body)
      },
      { wt: worktreeId, id: todoId as string, body: PAGE_MARKDOWN }
    )

    // ── Open the full page from the row affordance ──────────────────────
    const row = orcaPage.getByTestId('todo-section-worktree').getByTestId('todo-row').filter({
      hasText: TODO_BODY
    })
    await row.hover()
    await row.getByTestId('todo-open-page').click()

    const page = orcaPage.getByTestId('todo-full-page')
    await expect(page).toBeVisible()
    await expect(page.getByTestId('todo-full-page-title')).toHaveText(TODO_BODY)

    // ── The real Orca markdown editor renders the page (sub-list + link) ─
    const editor = page.locator('.rich-markdown-editor')
    await expect(editor).toBeVisible({ timeout: 20_000 })
    await expect(editor).toContainText('nested')
    await expect(editor.getByRole('link', { name: 'docs' })).toBeVisible()

    // ── Edit in the rich editor → persists via setTodoNotesDoc (debounced) ─
    // Click the editor's empty area below the content so the caret lands at the
    // document end, then type — appends without disturbing the list/link. (A
    // select-all here would replace the whole doc, which is expected editor behavior.)
    const editorBox = await editor.boundingBox()
    await editor.click({ position: { x: 24, y: (editorBox?.height ?? 480) - 24 } })
    await orcaPage.keyboard.type(' EDITED')
    await expect
      .poll(
        () =>
          orcaPage.evaluate((wt) => {
            const list = window.__store?.getState().getTodos('worktree', wt) ?? []
            return list.find((t) => t.body === 'Full page todo')?.notesDoc ?? ''
          }, worktreeId),
        { timeout: 10_000 }
      )
      .toContain('EDITED')

    // Diagnostic / no-data-loss guard: the edit must preserve existing content.
    const docAfterEdit = await orcaPage.evaluate(
      ([wt, body]) => {
        const list = window.__store?.getState().getTodos('worktree', wt) ?? []
        return list.find((t) => t.body === body)?.notesDoc ?? ''
      },
      [worktreeId, TODO_BODY] as const
    )
    expect(docAfterEdit, 'notesDoc after edit (pre-reload)').toContain('nested')

    // ── Add a timeline update on the full page ──────────────────────────
    const addNote = page.getByTestId('todo-note-add')
    await addNote.fill(UPDATE_BODY)
    await addNote.press('Enter')
    const update = page.getByTestId('todo-note').filter({ hasText: UPDATE_BODY })
    await expect(update).toBeVisible()
    await expect(update.getByTestId('todo-note-meta')).toContainText('user')

    // ── Reload → reopen → page content persists in the rich editor ──────
    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForSessionReady(orcaPage)
    const reloadedWorktreeId = await waitForActiveWorktree(orcaPage)
    await openTodos(orcaPage, reloadedWorktreeId)

    const reloadedRow = orcaPage
      .getByTestId('todo-section-worktree')
      .getByTestId('todo-row')
      .filter({ hasText: TODO_BODY })
    await expect(reloadedRow).toBeVisible({ timeout: 10_000 })
    await reloadedRow.hover()
    await reloadedRow.getByTestId('todo-open-page').click()

    const reloadedEditor = orcaPage.getByTestId('todo-full-page').locator('.rich-markdown-editor')
    await expect(reloadedEditor).toBeVisible({ timeout: 20_000 })
    await expect(reloadedEditor).toContainText('nested')
    await expect(reloadedEditor).toContainText('EDITED')
    await expect(reloadedEditor.getByRole('link', { name: 'docs' })).toBeVisible()
    await expect(
      orcaPage
        .getByTestId('todo-full-page')
        .getByTestId('todo-note')
        .filter({ hasText: UPDATE_BODY })
    ).toBeVisible()
  })
})
