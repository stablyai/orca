import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { waitForActivePanePtyId, waitForPaneIdentitySnapshot } from '../../terminal/input/terminal'
import { waitForActivePaneHookDescriptor } from '../../terminal/input/terminal-active-pane'
import { waitForActiveTerminalManager } from '../../terminal/layout/terminal-pane-operations'
import { waitForPtyShellEcho } from '../../terminal/lifecycle/terminal-pty-readiness'

import {
  TRANSCRIPT_ROWS,
  type PrependTrace,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView,
  activateNewTerminalTab,
  activateTerminalTab,
  publishHiddenLaunchMessage,
  claudeTranscript
} from './native-chat-history-prepend-session'

test.describe('Native chat transcript anchoring', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1280, height: 900 })
  })
  for (const tools of [false, true]) {
    test(`keeps ${tools ? 'tool-heavy' : 'text'} content at its viewport offset in every painted frame`, async ({
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)

      const boundPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
      const ptyId = await waitForActivePanePtyId(orcaPage)
      await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
      const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
      expect(descriptor.paneKey).toBe(`${boundPane.tabId}:${boundPane.activeLeafId}`)
      const [tabId] = descriptor.paneKey.split(':')
      const sessionId = `e2e-prepend-anchor-${randomUUID()}`
      const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-anchor-'))
      const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
      writeFileSync(transcriptPath, claudeTranscript(TRANSCRIPT_ROWS, sessionId, tools))

      try {
        await enableNativeChatSetting(orcaPage)
        await seedClaudeProviderSession(orcaPage, {
          paneKey: descriptor.paneKey,
          worktreeId: descriptor.worktreeId,
          sessionId,
          transcriptPath
        })
        // Exercise the supported manual paging fallback while the reader stays mid-transcript.
        await orcaPage.evaluate(() => {
          Object.defineProperty(window, 'IntersectionObserver', {
            value: undefined,
            configurable: true
          })
        })
        await toggleTerminalTabToChatView(orcaPage, {
          tabId,
          worktreeId: descriptor.worktreeId
        })

        await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
          timeout: 15_000
        })
        const scroll = orcaPage.locator('[data-native-chat-scroll]')
        const transcriptWindow = orcaPage.locator('[data-native-chat-window]')
        const loadEarlier = orcaPage.getByRole('button', { name: 'Load earlier messages' })
        await expect(transcriptWindow).toBeVisible({ timeout: 30_000 })
        await expect(loadEarlier).toBeAttached({ timeout: 30_000 })
        await expect
          .poll(() => transcriptWindow.locator(':scope > [data-index]').count())
          .toBeGreaterThan(3)

        const initialTotalSize = await transcriptWindow.evaluate(
          (element: HTMLElement) => element.offsetHeight
        )
        const anchor = await scroll.evaluate(async (element) => {
          element.scrollTop = element.scrollHeight * 0.55
          element.dispatchEvent(new Event('scroll', { bubbles: true }))
          let previousGeometry = ''
          let stableFrames = 0
          for (let frame = 0; frame < 120 && stableFrames < 5; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            const geometry = `${element.scrollHeight}:${element.scrollTop}`
            stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
            previousGeometry = geometry
          }
          const scrollRect = element.getBoundingClientRect()
          const candidates = Array.from(
            element.querySelectorAll<HTMLElement>('[data-native-chat-window] > [data-index]')
          ).filter((row) => {
            const rect = row.getBoundingClientRect()
            return rect.top >= scrollRect.top + 40 && rect.bottom <= scrollRect.bottom - 40
          })
          const row = candidates[Math.floor(candidates.length / 2)]
          const marker = row
            ? Array.from(row.querySelectorAll('p')).find((paragraph) =>
                /^E2E transcript row \d{4}$/.test(paragraph.textContent?.trim() ?? '')
              )
            : undefined
          if (!row || !marker) {
            return null
          }
          return {
            index: Number(row.dataset.index),
            marker: marker.textContent?.trim() ?? '',
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
            viewportOffset: row.getBoundingClientRect().top - scrollRect.top,
            contentOffset: marker.getBoundingClientRect().top - scrollRect.top
          }
        })
        expect(anchor, 'expected a fully visible measured row to anchor').not.toBeNull()
        if (!anchor) {
          throw new Error('Expected a fully visible measured row to anchor')
        }

        await orcaPage.evaluate((marker) => {
          const trace: PrependTrace = {
            active: true,
            frames: []
          }
          window.__nativeChatPrependTrace = trace
          const sample = () => {
            const channel = new MessageChannel()
            channel.port1.onmessage = () => {
              const paragraph = Array.from(document.querySelectorAll('p')).find(
                (node) => node.textContent?.trim() === marker
              )
              const root = paragraph?.closest('[data-native-chat-scroll]')
              const row = paragraph?.closest('[data-index]')
              const top = root?.getBoundingClientRect().top ?? 0
              trace.frames.push({
                content: paragraph ? paragraph.getBoundingClientRect().top - top : null,
                slot: row ? row.getBoundingClientRect().top - top : null
              })
              channel.port1.close()
              channel.port2.close()
              if (trace.active) {
                requestAnimationFrame(sample)
              }
            }
            channel.port2.postMessage(0)
          }
          requestAnimationFrame(sample)
        }, anchor.marker)
        // Invoke the off-screen button directly so Playwright cannot scroll the reader to the head before paging.
        await loadEarlier.evaluate((button: HTMLButtonElement) => button.click())
        await expect
          .poll(() => transcriptWindow.evaluate((element: HTMLElement) => element.offsetHeight))
          .toBeGreaterThan(initialTotalSize)
        await expect(loadEarlier).toBeAttached({ timeout: 30_000 })

        const anchoredMarker = orcaPage.getByText(anchor.marker, { exact: true })
        await expect(anchoredMarker).toBeAttached({ timeout: 15_000 })
        const after = await anchoredMarker.evaluate(async (marker) => {
          const row = marker.closest<HTMLElement>('[data-index]')
          const scrollRoot = marker.closest<HTMLElement>('[data-native-chat-scroll]')
          if (!row || !scrollRoot) {
            return null
          }
          let previousGeometry = ''
          let stableFrames = 0
          for (let frame = 0; frame < 120 && stableFrames < 5; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            const geometry = `${scrollRoot.scrollHeight}:${scrollRoot.scrollTop}`
            stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
            previousGeometry = geometry
          }
          return {
            index: Number(row.dataset.index),
            scrollHeight: scrollRoot.scrollHeight,
            scrollTop: scrollRoot.scrollTop,
            viewportOffset: row.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top
          }
        })
        expect(after, 'anchored row must remain mounted after history prepends').not.toBeNull()
        const contentGrowth = (after?.scrollHeight ?? 0) - anchor.scrollHeight
        const scrollAdjustment = (after?.scrollTop ?? 0) - anchor.scrollTop
        expect(
          Math.abs(contentGrowth - scrollAdjustment),
          `content grew ${contentGrowth}px while scrollTop adjusted ${scrollAdjustment}px`
        ).toBeLessThanOrEqual(2)
        const frames = await orcaPage.evaluate(() => {
          const trace = window.__nativeChatPrependTrace
          if (!trace) {
            throw new Error('Prepend trace was not started')
          }
          trace.active = false
          return trace.frames
        })
        await testInfo.attach('prepend-frames.json', {
          body: JSON.stringify({ anchor, frames }, null, 2),
          contentType: 'application/json'
        })
        expect(frames.length).toBeGreaterThan(0)
        expect(
          frames.every((frame) => frame.content !== null),
          'the same readable content stays mounted'
        ).toBe(true)
        expect(
          Math.max(
            ...frames.map((frame) => Math.abs((frame.content ?? Infinity) - anchor.contentOffset))
          )
        ).toBeLessThanOrEqual(2)
        if (!tools) {
          await loadEarlier.evaluate((button: HTMLButtonElement) =>
            button.focus({ preventScroll: true })
          )
          await orcaPage.keyboard.press('Enter')
          await expect(loadEarlier).not.toBeAttached()
          await expect(scroll).toBeFocused()
        }
        const finalPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
        expect(finalPane.tabId).toBe(boundPane.tabId)
        expect(finalPane.activeLeafId).toBe(boundPane.activeLeafId)
        expect(finalPane.ptyIdsByLeafId).toEqual(boundPane.ptyIdsByLeafId)
        await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible()
      } finally {
        rmSync(scratchDir, { recursive: true, force: true })
      }
    })
  }

  test('keeps a detached transcript in place across a hidden update', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const boundPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    expect(descriptor.paneKey).toBe(`${boundPane.tabId}:${boundPane.activeLeafId}`)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-hidden-scroll-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-hidden-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, claudeTranscript(TRANSCRIPT_ROWS, sessionId))

    try {
      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, {
        tabId,
        worktreeId: descriptor.worktreeId
      })

      const root = orcaPage.locator('[data-native-chat-root="true"]')
      const scroll = orcaPage.locator('[data-native-chat-scroll]')
      const jump = orcaPage.getByRole('button', { name: 'Jump to latest' })
      await expect(root).toBeVisible({ timeout: 15_000 })
      await expect(orcaPage.getByText('E2E transcript row 0649', { exact: true })).toBeAttached({
        timeout: 30_000
      })
      await scroll.hover()
      await orcaPage.mouse.wheel(0, -2_000)
      await expect
        .poll(async () =>
          scroll.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop
          )
        )
        .toBeGreaterThan(1_000)
      // Rows the wheel mounted above the reader settle their measured heights frames later.
      const readingAt = await scroll.evaluate(async (element) => {
        let previousGeometry = ''
        let stableFrames = 0
        for (let frame = 0; frame < 120 && stableFrames < 5; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const geometry = `${element.scrollHeight}:${element.scrollTop}`
          stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
          previousGeometry = geometry
        }
        return element.scrollTop
      })
      await expect(jump).toBeVisible()

      await activateNewTerminalTab(orcaPage, descriptor.worktreeId)
      await expect(root).toBeHidden()
      await publishHiddenLaunchMessage(orcaPage, {
        tabId,
        text: 'E2E update received while the transcript is hidden'
      })
      await activateTerminalTab(orcaPage, tabId)

      await expect(root).toBeVisible({ timeout: 15_000 })
      await expect(
        orcaPage.getByText('E2E update received while the transcript is hidden', { exact: true })
      ).toBeAttached()
      await expect
        .poll(async () =>
          Math.abs((await scroll.evaluate((element) => element.scrollTop)) - readingAt)
        )
        .toBeLessThanOrEqual(2)
      // Late measurements must not move the reader on any of the next painted frames.
      const laterDrift = await scroll.evaluate(async (element, reading) => {
        let drift = 0
        for (let frame = 0; frame < 30; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          drift = Math.max(drift, Math.abs(element.scrollTop - reading))
        }
        return drift
      }, readingAt)
      expect(laterDrift).toBeLessThanOrEqual(2)
      await expect(jump).toBeVisible()
      const finalPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(finalPane.tabId).toBe(boundPane.tabId)
      expect(finalPane.activeLeafId).toBe(boundPane.activeLeafId)
      expect(finalPane.ptyIdsByLeafId).toEqual(boundPane.ptyIdsByLeafId)
      await expect(root).toBeVisible()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
