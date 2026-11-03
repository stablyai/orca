import type { Editor } from '@tiptap/core'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { pressShortcut } from './helpers/shortcuts'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const FIRST = 'First alpha paragraph for pointer selection.'
const SECOND = 'Second beta paragraph for pointer selection.'
const SOURCE = [
  '# Adversarial Find interactions',
  'Needle first match.',
  ...Array.from({ length: 65 }, (_, index) => `Spacer ${index} keeps the search match away.`),
  FIRST,
  SECOND,
  '| Left | Right |\n| --- | --- |\n| Cell alpha | Cell beta |\n| Cell gamma | Cell delta |',
  '- [ ] Task marker',
  '<details open>\n<summary>Details marker</summary>\n\nDetails body marker\n\n</details>',
  '```javascript\nconst codeMarker = "clean";\n```',
  'Late target paragraph for a pending query.',
  ...Array.from({ length: 30 }, (_, index) => `Tail spacer ${index} keeps the second match away.`),
  'Needle final match.'
].join('\n\n')

async function textPoint(target: Locator, offset: number) {
  return target.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let node = walker.nextNode()
    while (node) {
      if (node instanceof Text && remaining <= node.length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const bounds = range.getBoundingClientRect()
        return { x: bounds.left, y: bounds.top + bounds.height / 2 }
      }
      remaining -= node.textContent?.length ?? 0
      node = walker.nextNode()
    }
    throw new Error('Text offset was not found')
  }, offset)
}

async function selectedText(page: Page) {
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

async function centered(target: Locator) {
  await target.evaluate((element) => element.scrollIntoView({ block: 'center' }))
}

async function find(page: Page, query = 'Needle', status = '1/2') {
  await pressShortcut(page, 'f')
  const input = page.getByRole('textbox', { name: 'Find in rich markdown editor' })
  await expect(input).toBeFocused()
  await input.fill(query)
  await expect(page.locator('.rich-markdown-search-status')).toHaveText(status)
  return input
}

async function drag(page: Page, start: Locator, end: Locator, from: number, to: number) {
  const firstPoint = await textPoint(start, from)
  const lastPoint = await textPoint(end, to)
  await page.mouse.move(firstPoint.x, firstPoint.y)
  await page.mouse.down()
  await page.mouse.move(lastPoint.x, lastPoint.y, { steps: 15 })
  await page.mouse.up()
}

test.beforeEach(async ({ orcaPage, registerPostElectronShutdownCleanup }, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-markdown-adversarial',
    'find-interactions',
    testInfo.workerIndex,
    SOURCE
  )
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await editor.locator('p').first().click()
})

test('toolbar formatting consumes completed forward and backward native drags', async ({
  orcaPage
}) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  for (const action of [
    { label: 'Bold', paragraph: FIRST, from: 6, to: 11, selected: 'alpha', tag: 'strong' },
    { label: 'Heading 2', paragraph: SECOND, from: 11, to: 7, selected: 'beta', tag: 'h2' }
  ]) {
    const paragraph = editor.getByText(action.paragraph, { exact: true })
    await centered(paragraph)
    const start = await textPoint(paragraph, action.from)
    const end = await textPoint(paragraph, action.to)
    await orcaPage.mouse.move(start.x, start.y)
    await orcaPage.mouse.down()
    await editor.evaluate((element, expected) => {
      element.removeAttribute('data-observed-native-selection')
      const observe = () => {
        if (document.getSelection()?.toString() === expected) {
          element.setAttribute('data-observed-native-selection', expected)
          document.removeEventListener('selectionchange', observe)
        }
      }
      document.addEventListener('selectionchange', observe)
    }, action.selected)
    await orcaPage.mouse.move(end.x, end.y, { steps: 15 })
    // Deliver the final native notification while held; mouseup must not need another endpoint change.
    await expect(editor).toHaveAttribute('data-observed-native-selection', action.selected)
    await orcaPage.mouse.up()
    expect(await selectedText(orcaPage)).toBe(action.selected)
    await expect(editor).toBeFocused()
    // No key, blur or command may rescue publication before passive selection UI appears.
    await expect(
      orcaPage.getByRole('button', { name: 'Add review note', exact: true })
    ).toBeVisible()
    const published = await editor.evaluate((element) => {
      const instance = element.closest<HTMLElement & { editor?: Editor }>(
        '.rich-markdown-editor'
      )?.editor
      const native = document.getSelection()
      if (!instance || !native?.anchorNode || !native.focusNode) {
        throw new Error('Expected editor/native selection')
      }
      return (
        instance.state.selection.anchor ===
          instance.view.posAtDOM(native.anchorNode, native.anchorOffset) &&
        instance.state.selection.head ===
          instance.view.posAtDOM(native.focusNode, native.focusOffset)
      )
    })
    expect(published).toBe(true)
    await orcaPage.getByRole('button', { name: action.label, exact: true }).click()
    await expect(editor.locator(action.tag)).toHaveText(
      action.label === 'Bold' ? action.selected : action.paragraph
    )
  }
  await expect(editor.locator('p').filter({ hasText: FIRST })).toHaveCount(1)
  await expect(editor.locator('strong')).toHaveText('alpha')
})

test('Find preserves Shift-click, double-click, and multi-paragraph copy selection', async ({
  orcaPage
}, testInfo) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  const first = editor.getByText(FIRST, { exact: true })
  const second = editor.getByText(SECOND, { exact: true })
  const search = await find(orcaPage)
  await centered(first)
  const viewport = orcaPage.locator('.rich-markdown-editor-shell .overflow-auto')
  const scroll = await viewport.evaluate((element) => element.scrollTop)
  const start = await textPoint(first, 6)
  const end = await textPoint(second, 11)
  await orcaPage.mouse.click(start.x, start.y)
  await orcaPage.keyboard.down('Shift')
  await orcaPage.mouse.click(end.x, end.y)
  await orcaPage.keyboard.up('Shift')
  expect(await selectedText(orcaPage)).toBe(`${FIRST.slice(6)}\n\n${SECOND.slice(0, 11)}`)
  await expect(editor).toBeFocused()
  await expect(
    orcaPage
      .locator('[data-tab-id]')
      .filter({ hasText: 'find-interactions' })
      .last()
      .locator('span.rounded-full')
  ).toHaveCount(0)
  await orcaPage.mouse.click(start.x, start.y)
  await search.focus()
  await orcaPage.keyboard.down('Shift')
  await orcaPage.mouse.click(end.x, end.y)
  await orcaPage.keyboard.up('Shift')
  expect(await selectedText(orcaPage)).toBe(`${FIRST.slice(6)}\n\n${SECOND.slice(0, 11)}`)
  // Complete a native gesture, then leave and immediately extend it before drag reconciliation.
  await search.focus()
  await orcaPage.keyboard.down('Shift')
  await orcaPage.mouse.click(end.x, end.y)
  await orcaPage.keyboard.up('Shift')
  expect(await selectedText(orcaPage)).toBe(`${FIRST.slice(6)}\n\n${SECOND.slice(0, 11)}`)
  const copied = await editor.evaluate((element) => {
    const clipboard = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
    return { plain: clipboard.getData('text/plain'), html: clipboard.getData('text/html') }
  })
  expect(copied.plain).toContain(FIRST.slice(6))
  expect(copied.plain).toContain(SECOND.slice(0, 11))
  expect(copied.html).toContain('<p>')
  await expect(editor.getByText('Needle first match.', { exact: true })).toBeVisible()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(scroll, 0)
  await orcaPage.screenshot({ path: testInfo.outputPath('shift-click-copy-selection.png') })
  await orcaPage.getByRole('button', { name: 'Toggle replace', exact: true }).click()
  const replace = orcaPage.getByRole('textbox', { name: 'Replace in rich markdown editor' })
  await orcaPage.mouse.click(start.x, start.y)
  await replace.focus()
  await orcaPage.keyboard.down('Shift')
  await orcaPage.mouse.click(end.x, end.y)
  await orcaPage.keyboard.up('Shift')
  expect(await selectedText(orcaPage)).toBe(`${FIRST.slice(6)}\n\n${SECOND.slice(0, 11)}`)
  await search.focus()
  const word = await textPoint(first, 9)
  await orcaPage.mouse.dblclick(word.x, word.y)
  expect(await selectedText(orcaPage)).toBe('alpha')
  await orcaPage.keyboard.type('xy', { delay: 100 })
  await expect(
    editor.getByText('First xy paragraph for pointer selection.', { exact: true })
  ).toBeVisible()
  await expect(search).toHaveValue('Needle')
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/2')
  await search.focus()
  await orcaPage.mouse.click(word.x, word.y, { clickCount: 3 })
  expect((await selectedText(orcaPage)).trim()).toBe('First xy paragraph for pointer selection.')
})

test('backward native selection completes before focused copy and an inside-range Find handoff', async ({
  orcaPage
}) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  const first = editor.getByText(FIRST, { exact: true })
  const second = editor.getByText(SECOND, { exact: true })
  const search = await find(orcaPage)
  await centered(first)
  await drag(orcaPage, second, first, 11, 6)
  await orcaPage.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  const copied = await editor.evaluate((element) => {
    const instance = document.querySelector<HTMLElement & { editor?: Editor }>(
      '.rich-markdown-editor'
    )?.editor
    if (!instance) {
      throw new Error('Expected editor instance')
    }
    const native = document.getSelection()
    if (!native?.anchorNode || !native.focusNode) {
      throw new Error('Expected native range')
    }
    const anchor = instance.view.posAtDOM(native.anchorNode, native.anchorOffset)
    const head = instance.view.posAtDOM(native.focusNode, native.focusOffset)
    const clipboard = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard })
    )
    return {
      plain: clipboard.getData('text/plain'),
      anchor,
      head,
      model: instance.state.selection.toJSON()
    }
  })
  expect(copied.anchor).toBeGreaterThan(copied.head)
  expect(copied.model).toEqual({ type: 'text', anchor: copied.anchor, head: copied.head })
  expect(copied.plain).toBe(`${FIRST.slice(6)}\n\n${SECOND.slice(0, 11)}`)
  await expect(editor).toBeFocused()
  const inside = await textPoint(first, 12)
  await orcaPage.mouse.click(inside.x, inside.y)
  await pressShortcut(orcaPage, 'f')
  await expect(search).toBeFocused()
  const caret = await first.evaluate((element) => {
    const instance = document.querySelector<HTMLElement & { editor?: Editor }>(
      '.rich-markdown-editor'
    )?.editor
    if (!instance || !element.firstChild) {
      throw new Error('Expected editor paragraph')
    }
    return {
      expected: instance.view.posAtDOM(element.firstChild, 12),
      model: instance.state.selection.toJSON()
    }
  })
  expect(caret.model).toEqual({ type: 'text', anchor: caret.expected, head: caret.expected })
  const end = await textPoint(second, 11)
  await orcaPage.keyboard.down('Shift')
  await orcaPage.mouse.click(end.x, end.y)
  await orcaPage.keyboard.up('Shift')
  expect(await selectedText(orcaPage)).toBe(`${FIRST.slice(12)}\n\n${SECOND.slice(0, 11)}`)
  await orcaPage.keyboard.type('xy')
  await expect(
    editor.getByText(`${FIRST.slice(0, 12)}xy${SECOND.slice(11)}`, { exact: true })
  ).toBeVisible()
})

test('Replace input returns to a multi-paragraph drag and explicit next-match navigation', async ({
  orcaPage
}, testInfo) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  const search = await find(orcaPage)
  await orcaPage.getByRole('button', { name: 'Toggle replace', exact: true }).click()
  const replace = orcaPage.getByRole('textbox', { name: 'Replace in rich markdown editor' })
  await replace.fill('Thread')
  const first = editor.getByText(FIRST, { exact: true })
  const second = editor.getByText(SECOND, { exact: true })
  await centered(first)
  await drag(orcaPage, first, second, 6, 11)
  expect(await selectedText(orcaPage)).toBe(`${FIRST.slice(6)}\n\n${SECOND.slice(0, 11)}`)
  await orcaPage.keyboard.type('xy', { delay: 100 })
  await expect(
    editor.getByText(`${FIRST.slice(0, 6)}xy${SECOND.slice(11)}`, { exact: true })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Next match', exact: true }).click()
  await expect.poll(() => selectedText(orcaPage)).toBe('Needle')
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('2/2')
  await replace.focus()
  await orcaPage.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(editor.getByText('Thread final match.', { exact: true })).toBeVisible()
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/1')
  await expect(replace).toBeFocused()
  await orcaPage.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  await pressShortcut(orcaPage, 'f')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')
  await orcaPage.screenshot({ path: testInfo.outputPath('replace-next-reopen.png') })
})

test('Find returns focus and copies the intended cells after Shift-clicking a table', async ({
  orcaPage
}, testInfo) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  const search = await find(orcaPage, 'Cell alpha', '1/1')
  const firstCell = editor.getByText('Cell alpha', { exact: true })
  const lastCell = editor.getByText('Cell delta', { exact: true })
  await centered(firstCell)
  const viewport = orcaPage.locator('.rich-markdown-editor-shell .overflow-auto')
  const scroll = await viewport.evaluate((element) => element.scrollTop)
  const point = await textPoint(lastCell, 6)
  await orcaPage.keyboard.down('Shift')
  await orcaPage.mouse.move(point.x, point.y)
  await orcaPage.mouse.down()
  await orcaPage.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await orcaPage.mouse.up()
  await orcaPage.keyboard.up('Shift')
  await expect(editor.locator('td.selectedCell')).toHaveCount(4)
  await orcaPage.screenshot({ path: testInfo.outputPath('shift-cell-selection.png') })
  await expect(editor).toBeFocused()
  await expect(search).toHaveValue('Cell alpha')
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(scroll, 0)
  const tab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'find-interactions' }).last()
  await expect(tab.locator('span.rounded-full')).toHaveCount(0)
  const copied = await editor.evaluate((element) => {
    const clipboard = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard
      })
    )
    return clipboard.getData('text/plain')
  })
  expect(copied).toBe('Cell alpha\n\nCell beta\n\nCell gamma\n\nCell delta')
  await search.focus()
  await drag(orcaPage, firstCell, lastCell, 0, 10)
  await expect(editor).toBeFocused()
  expect((await selectedText(orcaPage)).replace(/\s+/g, ' ').trim()).toBe(
    'Cell alpha Cell beta Cell gamma Cell delta'
  )
  await expect(tab.locator('span.rounded-full')).toHaveCount(0)
})

test('Find preserves embedded task, details, and code editing', async ({ orcaPage }, testInfo) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  const search = await find(orcaPage)
  await centered(editor.getByRole('checkbox'))
  await search.focus()
  const checkbox = editor.getByRole('checkbox')
  await checkbox.check()
  await expect(checkbox).toBeChecked()
  await expect(search).toHaveValue('Needle')
  await search.focus()
  const details = editor.locator('[data-type="details"]')
  await details.getByRole('button').click()
  await expect(details.locator('[data-type="detailsContent"]')).toBeHidden()
  await search.focus()
  await details.getByRole('button').click()
  await expect(details.locator('[data-type="detailsContent"]')).toBeVisible()
  const body = editor.getByText('Details body marker', { exact: true })
  const bodyPoint = await textPoint(body, 7)
  await search.focus()
  await orcaPage.mouse.click(bodyPoint.x, bodyPoint.y)
  await orcaPage.keyboard.type('xy', { delay: 100 })
  await expect(editor.getByText('Detailsxy body marker', { exact: true })).toBeVisible()
  const code = editor.getByText('const codeMarker = "clean";', { exact: true })
  await centered(code)
  const codePoint = await textPoint(code, 6)
  const language = editor.locator('.rich-markdown-code-block-lang')
  await search.focus()
  await language.focus()
  await language.selectOption('typescript')
  await expect(language).toHaveValue('typescript')
  await search.focus()
  const copy = editor.getByRole('button', { name: 'Copy code', exact: true })
  await copy.hover()
  await orcaPage.mouse.down()
  await expect(copy).toBeFocused()
  await orcaPage.mouse.move(codePoint.x, codePoint.y)
  await orcaPage.mouse.up()
  await search.focus()
  await orcaPage.mouse.click(codePoint.x, codePoint.y)
  await orcaPage.keyboard.type('xy', { delay: 100 })
  await expect(editor.getByText('const xycodeMarker = "clean";', { exact: true })).toBeVisible()
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/2')
  await orcaPage.screenshot({ path: testInfo.outputPath('embedded-control-editing.png') })
})

test('a pending Find query cannot claim focus after document and checkbox interaction', async ({
  orcaPage
}, testInfo) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  const search = await find(orcaPage)
  const target = editor.getByText('Late target paragraph for a pending query.', { exact: true })
  await centered(target)
  const point = await textPoint(target, 5)
  const viewport = orcaPage.locator('.rich-markdown-editor-shell .overflow-auto')
  const scroll = await viewport.evaluate((element) => element.scrollTop)
  const checkbox = editor.getByRole('checkbox')
  const checkboxPoint = await checkbox.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
  })
  await search.fill('Cell alpha')
  await orcaPage.mouse.click(point.x, point.y)
  await expect(editor).toBeFocused()
  await orcaPage.mouse.click(checkboxPoint.x, checkboxPoint.y)
  await expect(checkbox).toBeChecked()
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/1')
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(scroll, 0)
  await expect(target).toHaveText('Late target paragraph for a pending query.')
  await orcaPage.mouse.click(point.x, point.y)
  await orcaPage.keyboard.type('xy', { delay: 100 })
  await expect(
    editor.getByText('Late xytarget paragraph for a pending query.', { exact: true })
  ).toBeVisible()
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/1')
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeCloseTo(scroll, 0)
  await expect(search).toHaveValue('Cell alpha')
  await orcaPage.screenshot({ path: testInfo.outputPath('pending-query-editor-caret.png') })
})

test('Replace advances when its replacement still contains the search query', async ({
  orcaPage
}, testInfo) => {
  const editor = orcaPage.locator('.rich-markdown-editor')
  await find(orcaPage)
  await orcaPage.getByRole('button', { name: 'Toggle replace', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'Replace in rich markdown editor' }).fill('NeedleX')
  await orcaPage.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(editor.getByText('NeedleX first match.', { exact: true })).toBeVisible()
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('2/2')
  await expect(
    editor.getByText('Needle final match.', { exact: true }).locator('[data-active="true"]')
  ).toHaveText('Needle')
  await orcaPage.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(editor.getByText('NeedleX final match.', { exact: true })).toBeVisible()
  await expect(editor.getByText('NeedleX first match.', { exact: true })).toBeVisible()
  await expect(orcaPage.locator('.rich-markdown-search-status')).toHaveText('1/2')
  await orcaPage.screenshot({ path: testInfo.outputPath('replacement-retains-query.png') })
})
