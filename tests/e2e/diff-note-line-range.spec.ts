import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { pressShortcut } from './helpers/shortcuts'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

/**
 * Selecting a range of diff lines for an AI note, through the real gutter
 * gesture rather than the store. What matters here and cannot be unit-tested:
 * the press is taken away from Monaco's own gutter selection, the band tracks
 * the pointer while the button is held, it stays lit under the open composer,
 * and a plain click still produces the single-line note it always did.
 */

const BAND = '.orca-diff-comment-range-highlight'
const COMPOSER = '.orca-diff-comment-popover'
const COMPOSER_LABEL = '.orca-diff-comment-popover-label'
const COMPOSER_TEXTAREA = '.orca-diff-comment-popover-textarea'

type StoredNote = { startLine?: number; lineNumber: number; body: string }

// Committed baseline: the gesture needs a real unstaged modification of a tracked
// file. A brand-new file is untracked, and its diff opens with no gutter lines.
const SEED_BASELINE = 'export const seed = true\n'
const SEED_LINE_COUNT = 24
// Highest gutter line any test below reaches; seeing it proves the modified model
// (not just the first cell) has landed before the gesture starts.
const SEED_SYNC_LINE = 9

async function seedDiffFile(page: Page, worktreeId: string, relative: string): Promise<void> {
  const { worktreePath, storeRel } = await page.evaluate(
    ({ wId, rel }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available - is the app in dev mode?')
      }
      const worktree = Object.values(store.getState().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        throw new Error('active worktree not found')
      }
      const separator = worktree.path.includes('\\') ? '\\' : '/'
      return { worktreePath: worktree.path, storeRel: rel.split('/').join(separator) }
    },
    { wId: worktreeId, rel: relative }
  )

  // Commit the baseline when it is not already tracked (idempotent across reruns
  // on the worker-scoped fixture repo), then rewrite the working tree on top.
  const absolutePath = path.join(worktreePath, ...relative.split('/'))
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, SEED_BASELINE)
  const porcelain = execFileSync('git', ['status', '--porcelain', '--', relative], {
    cwd: worktreePath,
    encoding: 'utf8'
  })
  if (porcelain.trim() !== '') {
    execFileSync('git', ['add', '--', relative], { cwd: worktreePath, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', `e2e seed ${relative} for diff-note-range`], {
      cwd: worktreePath,
      stdio: 'pipe'
    })
  }
  const lines = Array.from(
    { length: SEED_LINE_COUNT },
    (_, index) => `export const line${String(index + 1).padStart(2, '0')} = ${index + 1}`
  )
  writeFileSync(absolutePath, `${lines.join('\n')}\n`)

  await page.evaluate(
    async ({ wId, rel }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available - is the app in dev mode?')
      }
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        throw new Error('active worktree not found')
      }
      const separator = worktree.path.includes('\\') ? '\\' : '/'
      // Inline keeps the modified side's line numbers in its own margin, which is the
      // column the gesture is aimed at.
      await state.updateSettings({ diffDefaultView: 'inline' })
      state.openDiff(wId, `${worktree.path}${separator}${rel}`, rel, 'typescript', false)
    },
    { wId: worktreeId, rel: storeRel }
  )
  await expect(
    page.locator('.modified-in-monaco-diff-editor .margin .line-numbers').first(),
    'diff gutter never rendered'
  ).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => hasGutterLine(page, SEED_SYNC_LINE), {
      timeout: 20_000,
      message: 'modified diff content never rendered its gutter lines'
    })
    .toBe(true)
}

async function readGutterPoint(
  page: Page,
  lineNumber: number
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((target: number) => {
    const editor = document.querySelector('.monaco-editor.modified-in-monaco-diff-editor')
    if (!editor) {
      return null
    }
    for (const cell of editor.querySelectorAll('.margin .line-numbers')) {
      if (Number.parseInt(cell.textContent?.trim() ?? '', 10) === target) {
        const rect = cell.getBoundingClientRect()
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      }
    }
    return null
  }, lineNumber)
}

async function hasGutterLine(page: Page, lineNumber: number): Promise<boolean> {
  return (await readGutterPoint(page, lineNumber)) !== null
}

// Centre of a line's number cell — the column the "+" lives in and the gesture starts from.
async function gutterPoint(page: Page, lineNumber: number): Promise<{ x: number; y: number }> {
  let point: { x: number; y: number } | null = null
  await expect
    .poll(
      async () => {
        point = await readGutterPoint(page, lineNumber)
        return point
      },
      {
        timeout: 20_000,
        message: `line ${lineNumber} is not rendered in the modified gutter`
      }
    )
    .not.toBeNull()
  if (point == null) {
    throw new Error(`line ${lineNumber} is not rendered in the modified gutter`)
  }
  return point
}

// Box of the "+" affordance, which only exists while its line is hovered.
async function revealAddButton(
  page: Page,
  lineNumber: number
): Promise<{ x: number; y: number; top: string }> {
  const line = await gutterPoint(page, lineNumber)
  await page.mouse.move(line.x + 260, line.y)
  const button = page.locator('.orca-diff-comment-add-btn')
  await expect(button, 'the "+" never appeared on the hovered line').toBeVisible()
  const box = await button.boundingBox()
  if (!box) {
    throw new Error('the "+" has no box')
  }
  const top = await button.evaluate((node) => {
    if (!(node instanceof HTMLElement)) {
      throw new Error('the add button is not an HTMLElement')
    }
    return node.style.top
  })
  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
    top
  }
}

async function readNotes(page: Page, worktreeId: string): Promise<StoredNote[]> {
  return page.evaluate((wId: string) => {
    const worktree = Object.values(window.__store?.getState().worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.id === wId)
    return (worktree?.diffComments ?? []).map((comment) => ({
      startLine: comment.startLine,
      lineNumber: comment.lineNumber,
      body: comment.body
    }))
  }, worktreeId)
}

async function submitNote(page: Page, body: string): Promise<void> {
  await page.locator(COMPOSER_TEXTAREA).fill(body)
  await page.keyboard.press('Enter')
  await expect(page.locator(COMPOSER), 'composer stayed open after submit').toHaveCount(0, {
    timeout: 10_000
  })
}

test.describe('Diff note line range', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
      await window
        .__store!.getState()
        .setKeybindingOverride('sourceControl.sendReviewNotes', ['Mod+Shift+Enter'])
    })
  })

  test('dragging the gutter selects a range, keeps it lit, and saves one ranged note', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await seedDiffFile(orcaPage, worktreeId, 'src/diff-note-range-drag.ts')

    const from = await gutterPoint(orcaPage, 4)
    const to = await gutterPoint(orcaPage, 9)

    await orcaPage.mouse.move(from.x, from.y)
    await orcaPage.mouse.down()
    // Anchor alone is lit before the pointer travels.
    await expect(orcaPage.locator(BAND)).toHaveCount(1)

    await orcaPage.mouse.move(to.x, (from.y + to.y) / 2)
    await orcaPage.mouse.move(to.x, to.y)
    await expect(
      orcaPage.locator(BAND),
      'the band did not follow the pointer while the button was held'
    ).toHaveCount(6)

    await orcaPage.mouse.up()

    await expect(orcaPage.locator(COMPOSER_LABEL)).toHaveText('Lines 4-9')
    await expect(
      orcaPage.locator(BAND),
      'the band should stay lit while the note is being written'
    ).toHaveCount(6)
    // The gutter press belongs to us, so Monaco never started a text selection under it.
    expect(await orcaPage.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

    await submitNote(orcaPage, 'Collapse these six lines into a loop.')

    expect(await readNotes(orcaPage, worktreeId)).toEqual([
      { startLine: 4, lineNumber: 9, body: 'Collapse these six lines into a loop.' }
    ])
    const card = orcaPage.locator('.orca-diff-comment-card').first()
    await expect(card, 'saved note card did not render').toBeVisible({ timeout: 15_000 })
    await expect(card).toContainText('lines 4-9')
    // The draft band belongs to the composer, so it clears with it.
    await expect(orcaPage.locator(BAND)).toHaveCount(0)
  })

  // Bottom-to-top: the anchor is the lower line, so the committed range only reads in document
  // order if the drag keeps anchor and focus apart instead of sorting them as it goes.
  test('dragging the gutter upward commits the same range as dragging down', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await seedDiffFile(orcaPage, worktreeId, 'src/diff-note-range-drag-up.ts')

    const from = await gutterPoint(orcaPage, 9)
    const to = await gutterPoint(orcaPage, 4)

    await orcaPage.mouse.move(from.x, from.y)
    await orcaPage.mouse.down()
    await expect(orcaPage.locator(BAND)).toHaveCount(1)

    await orcaPage.mouse.move(to.x, (from.y + to.y) / 2)
    await orcaPage.mouse.move(to.x, to.y)
    await expect(
      orcaPage.locator(BAND),
      'the band did not grow upward while the button was held'
    ).toHaveCount(6)

    await orcaPage.mouse.up()

    await expect(orcaPage.locator(COMPOSER_LABEL)).toHaveText('Lines 4-9')
    expect(await orcaPage.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

    await submitNote(orcaPage, 'Dragged bottom to top.')

    expect(await readNotes(orcaPage, worktreeId)).toEqual([
      { startLine: 4, lineNumber: 9, body: 'Dragged bottom to top.' }
    ])
    await expect(orcaPage.locator('.orca-diff-comment-card').first()).toContainText('lines 4-9')
  })

  // The gesture that used to collapse to a single line: the press starts on the "+", a node
  // Monaco does not own, so hit-testing under the pointer resolved nothing for the whole drag.
  test('dragging from the "+" itself selects a range and the button rides the selection', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await seedDiffFile(orcaPage, worktreeId, 'src/diff-note-range-button-drag.ts')

    const button = await revealAddButton(orcaPage, 4)
    const to = await gutterPoint(orcaPage, 9)

    await orcaPage.mouse.move(button.x, button.y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(button.x, (button.y + to.y) / 2)
    await orcaPage.mouse.move(button.x, to.y)

    await expect(
      orcaPage.locator(BAND),
      'the drag stalled because the pointer stayed over the "+"'
    ).toHaveCount(6)
    await expect
      .poll(
        async () =>
          orcaPage.locator('.orca-diff-comment-add-btn').evaluate((node) => {
            if (!(node instanceof HTMLElement)) {
              throw new Error('the add button is not an HTMLElement')
            }
            return node.style.top
          }),
        { message: 'the "+" did not ride the growing end of the selection' }
      )
      .not.toBe(button.top)

    await orcaPage.mouse.up()
    await expect(orcaPage.locator(COMPOSER_LABEL)).toHaveText('Lines 4-9')
    await submitNote(orcaPage, 'Dragged straight off the plus button.')

    expect(await readNotes(orcaPage, worktreeId)).toEqual([
      { startLine: 4, lineNumber: 9, body: 'Dragged straight off the plus button.' }
    ])
  })

  test('a press with no drag still saves the single-line note it always did', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await seedDiffFile(orcaPage, worktreeId, 'src/diff-note-range-click.ts')

    const point = await gutterPoint(orcaPage, 6)
    await orcaPage.mouse.move(point.x, point.y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.up()

    await expect(orcaPage.locator(COMPOSER_LABEL)).toHaveText('Line 6')
    await expect(orcaPage.locator(BAND)).toHaveCount(1)

    await submitNote(orcaPage, 'Single line still works.')

    // startLine stays undefined: the stored shape is byte-identical to the pre-range one.
    expect(await readNotes(orcaPage, worktreeId)).toEqual([
      { startLine: undefined, lineNumber: 6, body: 'Single line still works.' }
    ])
    await expect(orcaPage.locator('.orca-diff-comment-card').first()).toContainText('line 6')
  })

  test('Escape abandons a drag without opening a composer', async ({ orcaPage }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await seedDiffFile(orcaPage, worktreeId, 'src/diff-note-range-escape.ts')

    const from = await gutterPoint(orcaPage, 3)
    const to = await gutterPoint(orcaPage, 8)
    await orcaPage.mouse.move(from.x, from.y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(to.x, to.y)
    await expect(orcaPage.locator(BAND)).toHaveCount(6)

    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.locator(BAND), 'Escape left the band behind').toHaveCount(0)

    await orcaPage.mouse.up()
    await expect(
      orcaPage.locator(COMPOSER),
      'a cancelled drag must not open a composer on release'
    ).toHaveCount(0)
    expect(await readNotes(orcaPage, worktreeId)).toEqual([])
  })

  for (const surface of ['single', 'combined'] as const) {
    test(`the Add Review Note chord saves a ranged note in the ${surface} diff`, async ({
      orcaPage,
      electronApp
    }, testInfo) => {
      const worktreeId = await waitForActiveWorktree(orcaPage)
      await seedDiffFile(orcaPage, worktreeId, 'src/diff-note-range-chord.ts')
      if (surface === 'combined') {
        await orcaPage.evaluate(async (wId) => {
          const state = window.__store!.getState()
          const worktree = Object.values(state.worktreesByRepo)
            .flat()
            .find((entry) => entry.id === wId)!
          const status = await window.api.git.status({ worktreePath: worktree.path })
          state.openAllDiffs(wId, worktree.path, undefined, 'unstaged', status.entries)
        }, worktreeId)
        await expect(orcaPage.locator('.combined-diff-scroll-container')).toBeVisible()
      }

      // Click the code column, not the gutter: Monaco still owns that side.
      const line = await gutterPoint(orcaPage, 5)
      await orcaPage.mouse.click(line.x + 220, line.y)
      await orcaPage.keyboard.press('Shift+ArrowDown')
      await orcaPage.keyboard.press('Shift+ArrowDown')

      await pressShortcut(orcaPage, 'KeyA', { shift: true })

      await expect(orcaPage.locator(COMPOSER_LABEL)).toHaveText('Lines 5-7')
      const draft = orcaPage.locator(COMPOSER_TEXTAREA)
      await draft.fill('Range from the keyboard.')
      await pressShortcut(orcaPage, 'KeyA', { shift: true })
      await expect(draft).toHaveCount(1)
      await expect(draft).toHaveValue('Range from the keyboard.')
      await orcaPage.keyboard.press('Enter')
      await expect(orcaPage.locator(COMPOSER)).toHaveCount(0)
      await expect(orcaPage.locator('.orca-diff-comment-card').first()).toContainText(
        'Range from the keyboard.'
      )

      await orcaPage.locator('.orca-diff-comment-card').first().getByTitle('Edit note').click()
      const editDraft = orcaPage.locator('.orca-diff-comment-card textarea').first()
      await expect(editDraft).toHaveValue('Range from the keyboard.')
      await pressShortcut(orcaPage, 'Enter', { shift: true })
      await expect(orcaPage.getByRole('menu').getByText('New agent', { exact: true })).toBeVisible()
      await expect(editDraft).toHaveValue('Range from the keyboard.')
      const screenshot = testInfo.outputPath(`${surface}-diff-notes.png`)
      await orcaPage.screenshot({ path: screenshot })
      await testInfo.attach(`${surface} diff notes`, { path: screenshot, contentType: 'image/png' })
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible())
        )
      ).toBe(true)
    })
  }
})
