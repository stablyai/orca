import type { Page, Locator } from '@playwright/test'
import { expect } from '@playwright/test'
import { failStickyWorker } from './sticky-workers-roster.test-fixture'

export async function verifyStickyInput(
  page: Page,
  composer: Locator,
  database: string,
  session: string,
  fail?: () => Promise<string>
) {
  await composer.fill('Review this draft with a backward selection in the middle.')
  await composer.focus()
  const editor = await page.evaluateHandle(() => document.activeElement!)
  const instrumented = await page.evaluate(() =>
    ['chat', 'composer', 'strip'].every(
      (name) => performance.getEntriesByName(`sticky-workers:${name}:render`).length > 0
    )
  )
  await editor.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()!
    getSelection()!.setBaseAndExtent(text, 20, text, 12)
    for (const name of ['chat', 'composer', 'strip']) {
      performance.clearMarks(`sticky-workers:${name}:render`)
    }
  })
  const wake = async () => {
    const dispatch = fail ? await fail() : failStickyWorker(database, session)
    await page.evaluate(async (session) => {
      await window.api.runtime.call({
        method: 'orchestration.workerDockAcknowledge',
        params: { party: `orca_session_id:${session}`, settlements: [], acknowledged: false }
      })
    }, session)
    await expect(
      page
        .locator(`[data-worker-dock-row]`)
        .filter({ has: page.locator(`[data-worker-dock-open]`) })
        .filter({ hasText: 'Failed' })
        .first()
    ).toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('[data-worker-dock-row]')
          .evaluateAll(
            (rows, dispatch) =>
              rows.some(
                (row) =>
                  row.getAttribute('data-worker-dock-row')?.includes(dispatch) &&
                  row.textContent?.includes('Failed')
              ),
            dispatch
          )
      )
      .toBe(true)
  }
  await wake()
  const selection = await editor.evaluate((element) => ({
    sameEditor: element.isConnected && document.activeElement === element,
    anchor: getSelection()?.anchorOffset,
    focus: getSelection()?.focusOffset,
    counts: Object.fromEntries(
      ['chat', 'composer', 'strip'].map((name) => [
        name,
        performance.getEntriesByName(`sticky-workers:${name}:render`).length
      ])
    )
  }))
  expect(selection.sameEditor).toBe(true)
  expect(selection.anchor).toBe(20)
  expect(selection.focus).toBe(12)
  const client = await page.context().newCDPSession(page)
  await client.send('Input.imeSetComposition', {
    text: 'にほん',
    selectionStart: 0,
    selectionEnd: 3
  })
  await wake()
  const composition = await editor.evaluate((element) => ({
    sameEditor: element.isConnected && document.activeElement === element,
    text: element.textContent,
    anchor: getSelection()?.anchorOffset,
    focus: getSelection()?.focusOffset
  }))
  expect(composition.sameEditor).toBe(true)
  expect(composition.text).toContain('にほん')
  await client.send('Input.insertText', { text: '日本' })
  await client.detach()
  await editor.dispose()
  return {
    method:
      'Hidden Chromium DOM focus/backward selection and CDP composition during real dock feed settlement; native OS IME, OS focus and screen reader not tested',
    instrumented,
    selection: { ...selection, counts: instrumented ? selection.counts : null },
    composition
  }
}
