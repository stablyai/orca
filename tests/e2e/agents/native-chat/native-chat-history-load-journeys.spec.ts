// Older-history journeys around the Load earlier row: keyboard focus through a failing and
// retried load, and an older page admitted while the chat is hidden.
import { renameSync } from 'node:fs'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  TRANSCRIPT_ROWS,
  activateNewTerminalTab,
  activateTerminalTab,
  claudeTranscript,
  nextFrames,
  openSeededTerminalChat,
  restoreIntersectionObserver,
  settleScroll
} from './native-chat-history-prepend-session'

test.describe('Native chat older history', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1280, height: 900 })
  })

  test('keeps keyboard focus through a failed load, its retry and success', async ({
    orcaPage
  }) => {
    const chat = await openSeededTerminalChat(
      orcaPage,
      (sessionId) => claudeTranscript(TRANSCRIPT_ROWS, sessionId),
      { manualPaging: true }
    )
    try {
      const load = orcaPage.getByRole('button', { name: 'Load earlier messages' })
      const retry = orcaPage.getByRole('button', { name: 'Retry' })
      await expect(load).toBeAttached({ timeout: 30_000 })
      // The transcript goes missing, so reading the older page fails.
      const missing = `${chat.transcriptPath}.missing`
      renameSync(chat.transcriptPath, missing)

      await load.focus()
      await orcaPage.keyboard.press('Enter')
      await expect(retry).toBeFocused({ timeout: 30_000 })

      // A retry that fails again hands focus back to the new Retry.
      await orcaPage.keyboard.press('Enter')
      await expect(retry).toBeFocused({ timeout: 30_000 })

      // A retry that succeeds leaves focus in the transcript, on the next Load earlier.
      renameSync(missing, chat.transcriptPath)
      await orcaPage.keyboard.press('Enter')
      await expect(retry).toHaveCount(0, { timeout: 30_000 })
      await expect
        .poll(() => chat.scroll.evaluate((root) => root.contains(document.activeElement)))
        .toBe(true)
    } finally {
      chat.cleanup()
    }
  })

  test('restores the reader to what they last saw when an older page lands while hidden', async ({
    orcaPage
  }) => {
    const chat = await openSeededTerminalChat(
      orcaPage,
      (sessionId) => claudeTranscript(TRANSCRIPT_ROWS, sessionId),
      { manualPaging: true }
    )
    try {
      const load = orcaPage.getByRole('button', { name: 'Load earlier messages' })
      await expect(load).toBeAttached({ timeout: 30_000 })
      await chat.scroll.hover()
      await orcaPage.mouse.wheel(0, -2_500)
      await settleScroll(chat.scroll)
      const reading = await chat.scroll.evaluate((root) => {
        const top = root.getBoundingClientRect().top
        const marker = Array.from(root.querySelectorAll('p')).find(
          (node) =>
            /^E2E transcript row \d{4}$/.test(node.textContent?.trim() ?? '') &&
            node.getBoundingClientRect().top >= top
        )
        return marker
          ? { text: marker.textContent!.trim(), offset: marker.getBoundingClientRect().top - top }
          : null
      })
      expect(reading, 'a visible row marker to follow').not.toBeNull()
      const heightBefore = await chat.scroll.evaluate((root) => root.scrollHeight)

      // Hold the older page's read open long enough to hide the chat before it lands.
      const delayed = await orcaPage.evaluate(() => {
        const api = window.api.nativeChat
        const read = api.readSession.bind(api)
        const state = window as unknown as { __e2eOlderPageRead?: 'pending' | 'done' }
        try {
          Object.defineProperty(api, 'readSession', {
            configurable: true,
            value: (...args: Parameters<typeof read>) => {
              state.__e2eOlderPageRead = 'pending'
              return new Promise<void>((resolve) => setTimeout(resolve, 2_000))
                .then(() => read(...args))
                .finally(() => {
                  state.__e2eOlderPageRead = 'done'
                })
            }
          })
        } catch {
          return false
        }
        return api.readSession !== read
      })
      expect(delayed, 'the e2e build lets the test hold a history read open').toBe(true)
      await load.evaluate((button: HTMLButtonElement) => button.click())
      await restoreIntersectionObserver(orcaPage)
      await activateNewTerminalTab(orcaPage, chat.worktreeId)
      await expect(chat.scroll).toBeHidden()
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              () => (window as unknown as { __e2eOlderPageRead?: string }).__e2eOlderPageRead
            ),
          { timeout: 30_000 }
        )
        .toBe('done')
      // The page lands into the hidden chat.
      await nextFrames(orcaPage, 10)

      await activateTerminalTab(orcaPage, chat.tabId)
      await expect(chat.scroll).toBeVisible({ timeout: 15_000 })
      await settleScroll(chat.scroll)
      const after = await chat.scroll.evaluate((root, text) => {
        const top = root.getBoundingClientRect().top
        const marker = Array.from(root.querySelectorAll('p')).find(
          (node) => node.textContent?.trim() === text
        )
        return {
          offset: marker ? marker.getBoundingClientRect().top - top : null,
          height: root.scrollHeight
        }
      }, reading!.text)
      expect(after.height, 'the older page was admitted').toBeGreaterThan(heightBefore)
      expect(after.offset, 'the reader’s row is drawn again').not.toBeNull()
      expect(Math.abs(after.offset! - reading!.offset)).toBeLessThanOrEqual(2)
    } finally {
      chat.cleanup()
    }
  })
})
