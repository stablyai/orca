import { expect, test, type Page } from '@playwright/test'

/** The editor element; the prompt editor keeps its Tiptap editor on it. */
type EditorElement = HTMLElement & {
  editor: {
    commands: { setTextSelection: (at: number) => void }
    state: { selection: { anchor: number; head: number } }
  }
}

/** The editor selection as `anchor-head`. */
function selection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const { anchor, head } =
      document.querySelector<EditorElement>('.ProseMirror')!.editor.state.selection
    return `${anchor}-${head}`
  })
}

async function open(page: Page, fixture: string, caret: number): Promise<void> {
  await page.goto(
    `/fixtures.html?id=native-chat/composer/editor/NativeChatQuote:${fixture}&theme=light`
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
  await page.locator('.ProseMirror').click()
  await page.evaluate((at) => {
    document.querySelector<EditorElement>('.ProseMirror')!.editor.commands.setTextSelection(at)
  }, caret)
  // The click's own caret move can come later; the caret starts where the test put it.
  await expect.poll(() => selection(page)).toBe(`${caret}-${caret}`)
}

const LINE_START = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home'
const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'

// chipLine: line 0 'x' (1, 2), line 1 the chip (4 before it, 5 after it) and 'cd' (to 7),
// line 2 'yy' (9 to 11).
type KeyCase = [from: number, key: string, to: string]

// The browser's own moves: from before the chip they stop or land after it.
const FIXED: KeyCase[] = [
  [4, LINE_END, '7-7'],
  [4, `Shift+${LINE_END}`, '4-7'],
  [4, 'ArrowDown', '9-9'],
  [4, 'Shift+ArrowDown', '4-9'],
  [9, 'ArrowUp', '4-4'],
  [1, 'ArrowDown', '4-4']
]

// Regression guards: the browser does these right already, and the key handling must keep them.
const GUARDS: KeyCase[] = [
  [6, LINE_START, '4-4'],
  [6, `Shift+${LINE_START}`, '6-4'],
  [4, 'ArrowUp', '1-1'],
  [6, 'ArrowUp', '2-2'],
  [6, 'ArrowDown', '11-11'],
  [2, 'ArrowRight', '4-4'],
  [4, 'ArrowRight', '5-5'],
  [5, 'ArrowLeft', '4-4'],
  [4, 'ArrowLeft', '2-2']
]

for (const [from, key, to] of [...FIXED, ...GUARDS]) {
  test(`${key} from ${from} on a chip line goes to ${to}`, async ({ page }) => {
    await open(page, 'chipLine', from)
    await page.keyboard.press(key)
    await expect.poll(() => selection(page)).toBe(to)
  })
}

test('ArrowRight at the end, after a chip, leaves the caret where it is', async ({ page }) => {
  await open(page, 'chipAtEnd', 2)
  // Each place the browser draws the caret at, as an offset in the line: 1 is after the chip, and
  // 2 is past it, where ProseMirror then moves it back.
  await page.evaluate(() => {
    const { dataset } = document.documentElement
    dataset.caretOffsets = ''
    document.addEventListener('selectionchange', () => {
      dataset.caretOffsets += `${window.getSelection()?.focusOffset ?? -1} `
    })
  })
  await page.keyboard.press('ArrowRight')
  // Two frames: the browser reports a caret move, and ProseMirror answers it, within them.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  expect(await selection(page)).toBe('2-2')
  const offsets = await page.evaluate(() => document.documentElement.dataset.caretOffsets ?? '')
  expect(offsets.split(' ').filter(Boolean)).not.toContain('2')
})
