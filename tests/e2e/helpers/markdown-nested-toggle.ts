import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

const TOGGLE_RENDER_TIMEOUT_MS = 10_000

export const NESTED_TOGGLE_FIXTURE_DIRECTORY = '.orca-e2e-markdown-nested-toggle'

export const NESTED_TOGGLE_BODY_TEXT = 'Get back to ppl'

export const NESTED_TOGGLE_MARKDOWN = [
  '# 08/27/2026',
  '',
  '<details class="orca-details" data-orca-toggle="heading-3" open>',
  '<summary>08/26/2026</summary>',
  '',
  '<details class="orca-details" open>',
  '<summary>goals</summary>',
  '',
  '- Get back to ppl',
  '',
  '</details>',
  '',
  '- after inner toggle',
  '',
  '</details>',
  ''
].join('\n')

// An inner toggle carrying unsupported attributes cannot become an editable
// node, so the whole block must still fall back to byte-preserving passthrough.
export const UNSUPPORTED_NESTED_TOGGLE_MARKDOWN = [
  '<details class="orca-details" open>',
  '<summary>outer</summary>',
  '',
  '<details id="not-a-toggle">',
  '<summary>inner</summary>',
  '',
  'Body',
  '',
  '</details>',
  '',
  '</details>',
  ''
].join('\n')

export type RenderedToggles = {
  toggleCount: number
  nestedToggleCount: number
  summaries: string[]
  variants: (string | null)[]
  passthroughBlockCount: number
}

export async function readRenderedToggles(page: Page): Promise<RenderedToggles> {
  return page.evaluate(() => {
    const editor = document.querySelector('.rich-markdown-editor')
    const toggles = Array.from(editor?.querySelectorAll('[data-type="details"]') ?? [])

    return {
      toggleCount: toggles.length,
      nestedToggleCount:
        editor?.querySelectorAll('[data-type="details"] [data-type="details"]').length ?? 0,
      summaries: toggles.map(
        (toggle) => toggle.querySelector('summary')?.textContent?.trim() ?? ''
      ),
      variants: toggles.map((toggle) => toggle.getAttribute('data-orca-toggle')),
      passthroughBlockCount: editor?.querySelectorAll('[data-raw-markdown-html-block]').length ?? 0
    }
  })
}

export async function expectEditableNestedToggles(page: Page): Promise<void> {
  await expect
    .poll(async () => readRenderedToggles(page), {
      timeout: TOGGLE_RENDER_TIMEOUT_MS,
      message: 'Nested toggles did not render as editable toggle nodes'
    })
    .toEqual({
      toggleCount: 2,
      nestedToggleCount: 1,
      summaries: ['08/26/2026', 'goals'],
      variants: ['heading-3', null],
      passthroughBlockCount: 0
    })
}

export async function expectPassthroughFallback(page: Page): Promise<void> {
  const passthrough = page.locator('.rich-markdown-editor [data-raw-markdown-html-block]')
  await expect(passthrough).toHaveCount(1, { timeout: TOGGLE_RENDER_TIMEOUT_MS })
  await expect(passthrough).toContainText('<details id="not-a-toggle">')
}

async function selectionIsInsideNestedToggleBody(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const editor = document.querySelector('.rich-markdown-editor') as
      | (Element & { editor?: { state?: { selection?: { from?: number; empty?: boolean } } } })
      | null
    const paragraph = editor?.querySelector(
      '[data-type="details"] [data-type="details"] [data-type="detailsContent"] p'
    ) as (Element & { pmViewDesc?: { posAtStart?: number; posAtEnd?: number } }) | null
    const selection = editor?.editor?.state?.selection
    const from = selection?.from
    const start = paragraph?.pmViewDesc?.posAtStart
    const end = paragraph?.pmViewDesc?.posAtEnd

    if (
      !selection?.empty ||
      typeof from !== 'number' ||
      typeof start !== 'number' ||
      typeof end !== 'number'
    ) {
      return false
    }

    return from >= start && from <= end
  })
}

export async function placeCaretInNestedToggleBody(page: Page): Promise<void> {
  // Real input only: click the body text itself, then extend to end of line.
  await page
    .locator('.rich-markdown-editor')
    .getByText(NESTED_TOGGLE_BODY_TEXT, { exact: true })
    .click()
  await page.keyboard.press('End')

  await expect
    .poll(async () => selectionIsInsideNestedToggleBody(page), {
      timeout: 3_000,
      message: 'Clicking the nested toggle body text did not place the caret inside it'
    })
    .toBe(true)
}

export async function expectSentinelInsideNestedToggle(
  page: Page,
  sentinel: string
): Promise<void> {
  const nestedBody = page.locator(
    '.rich-markdown-editor [data-type="details"] [data-type="details"] [data-type="detailsContent"]'
  )
  await expect(nestedBody).toContainText(sentinel, { timeout: TOGGLE_RENDER_TIMEOUT_MS })
}

export function expectFileKeepsNesting(fileContents: string, sentinel: string): void {
  const outerOpen = fileContents.indexOf('<details class="orca-details" data-orca-toggle=')
  const innerOpen = fileContents.indexOf('<details class="orca-details" open>')
  const firstClose = fileContents.indexOf('</details>')
  const sentinelAt = fileContents.indexOf(sentinel)

  expect({
    openTagCount: fileContents.split('<details').length - 1,
    closeTagCount: fileContents.split('</details>').length - 1,
    innerIsNestedInOuter: outerOpen !== -1 && innerOpen > outerOpen,
    // The edited line has to stay inside the inner toggle, before its close.
    sentinelInsideInner: sentinelAt !== -1 && sentinelAt > innerOpen && sentinelAt < firstClose
  }).toEqual({
    openTagCount: 2,
    closeTagCount: 2,
    innerIsNestedInOuter: true,
    sentinelInsideInner: true
  })
}
