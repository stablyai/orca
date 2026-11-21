import { expect, test, type Page } from '@playwright/test'

async function open(page: Page, fixture: string, caret: number): Promise<void> {
  await page.goto(
    `/fixtures.html?id=native-chat/composer/editor/NativeChatQuote:${fixture}&theme=light`
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
  await page.locator('.ProseMirror').click()
  await page.evaluate((at) => {
    const editor = (document.querySelector('.ProseMirror') as HTMLElement & { editor: Editor })
      .editor
    editor.commands.setTextSelection(at)
  }, caret)
}

type Editor = {
  commands: { setTextSelection: (at: number) => void }
  state: { selection: { anchor: number; head: number } }
}

/** The selection after the browser and ProseMirror settle, as `anchor-head`. */
async function selection(page: Page): Promise<string> {
  // A caret the browser moves is read back by ProseMirror on selectionchange.
  await page.waitForTimeout(100)
  return page.evaluate(() => {
    const { anchor, head } = (
      document.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
    ).editor.state.selection
    return `${anchor}-${head}`
  })
}

const LINE_START = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home'
const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'

// chipLine: line 0 'x' (1, 2), line 1 the chip (4 before it, 5 after it) and 'cd' (to 7),
// line 2 'yy' (9 to 11).
const CASES: [from: number, key: string, to: string][] = [
  [4, LINE_END, '7-7'],
  [4, `Shift+${LINE_END}`, '4-7'],
  [6, LINE_START, '4-4'],
  [6, `Shift+${LINE_START}`, '6-4'],
  [4, 'ArrowDown', '9-9'],
  [4, 'Shift+ArrowDown', '4-9'],
  [4, 'ArrowUp', '1-1'],
  [9, 'ArrowUp', '4-4'],
  [1, 'ArrowDown', '4-4'],
  [6, 'ArrowUp', '2-2'],
  [6, 'ArrowDown', '11-11'],
  [2, 'ArrowRight', '4-4'],
  [4, 'ArrowRight', '5-5'],
  [5, 'ArrowLeft', '4-4'],
  [4, 'ArrowLeft', '2-2']
]

for (const [from, key, to] of CASES) {
  test(`${key} from ${from} on a chip line goes to ${to}`, async ({ page }) => {
    await open(page, 'chipLine', from)
    await page.keyboard.press(key)
    expect(await selection(page)).toBe(to)
  })
}

test('ArrowRight at the end, after a chip, keeps the caret where it is', async ({ page }) => {
  await open(page, 'chipAtEnd', 2)
  await page.keyboard.press('ArrowRight')
  expect(await selection(page)).toBe('2-2')
  // The browser's own caret stays after the chip too: ProseMirror does not move it back.
  const offset = await page.evaluate(() => window.getSelection()?.focusOffset)
  expect(offset).toBe(1)
})
