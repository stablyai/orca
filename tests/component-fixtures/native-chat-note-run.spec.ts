import { expect, test, type Page } from '@playwright/test'

async function open(page: Page, fixture: string): Promise<void> {
  await page.goto(
    `/fixtures.html?id=native-chat/viewport/virtualization/NativeChatTranscriptRowStack:${fixture}&theme=light`
  )
  await expect(page.locator('html')).toHaveAttribute('data-fixture-state', 'ready', {
    timeout: 30_000
  })
}

/** The space between each note line and the next, in the order they are drawn. */
async function gapsBetweenNotes(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const notes = [
      ...document.querySelectorAll<HTMLElement>('[data-native-chat-message-id^="note-"]')
    ].map((note) => note.getBoundingClientRect())
    return notes.slice(1).map((note, index) => Math.round(note.top - notes[index]!.bottom))
  })
}

test('a long run of notes stays 4 px apart across the slots it splits into', async ({ page }) => {
  await open(page, 'longNoteRun')

  const gaps = await gapsBetweenNotes(page)

  expect(gaps).toHaveLength(17)
  expect(new Set(gaps)).toEqual(new Set([4]))
})

test('an approval card between two slots of a run keeps the whole row gap', async ({ page }) => {
  await open(page, 'longNoteRunWithCard')
  const card = (await page.getByText('Approve?').boundingBox())!
  const nextNote = (await page.locator('[data-native-chat-message-id="note-8"]').boundingBox())!

  const gaps = await gapsBetweenNotes(page)

  // The slot after the card sits a full row gap (20 px) below it, not pulled up over it.
  expect(Math.round(nextNote.y - (card.y + card.height))).toBe(20)
  expect(gaps.filter((gap) => gap !== 4)).toHaveLength(1)
})
