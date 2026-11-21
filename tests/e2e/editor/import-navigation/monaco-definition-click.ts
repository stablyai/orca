import type { Page } from '@stablyai/playwright-test'

export function editorSelectionLine(page: Page): Promise<number | null> {
  return page.evaluate(
    () => window.__monacoEditorE2E?.snapshot().selection?.selectionStartLineNumber ?? null
  )
}

// Monaco merges same-colored tokens into one span, so locate the name by its text range.
export async function modifierClickName(page: Page, lineText: string, name: string): Promise<void> {
  const point = await page.evaluate(
    ({ lineText, name }) => {
      for (const line of document.querySelectorAll('.monaco-editor .view-line')) {
        if (!line.textContent?.replace(/\u00a0/g, ' ').includes(lineText)) {
          continue
        }
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const index = node.textContent?.lastIndexOf(name) ?? -1
          if (index === -1) {
            continue
          }
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + name.length)
          const rect = range.getBoundingClientRect()
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        }
      }
      return null
    },
    { lineText, name }
  )
  if (!point) {
    throw new Error(`No rendered "${name}" on the line containing "${lineText}"`)
  }
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.mouse.move(point.x, point.y)
  await page.keyboard.down(modifier)
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up(modifier)
}
