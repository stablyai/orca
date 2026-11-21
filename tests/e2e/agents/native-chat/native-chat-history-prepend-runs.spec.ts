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
  RUN_COMMANDS,
  type PrependTrace,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView,
  settleScroll,
  nextFrames,
  claudeRunTranscript,
  claudeTranscript
} from './native-chat-history-prepend-session'

test.describe('Native chat transcript anchoring through runs, wheels and jumps', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1280, height: 900 })
  })
  test('keeps a partly visible command in place when an older page extends its open run', async ({
    orcaPage
  }) => {
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
    const sessionId = `e2e-run-anchor-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-run-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, claudeRunTranscript(sessionId))

    try {
      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      // Manual paging keeps the reader parked at the run instead of auto-loading on approach.
      await orcaPage.evaluate(() => {
        Object.defineProperty(window, 'IntersectionObserver', {
          value: undefined,
          configurable: true
        })
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      const scroll = orcaPage.locator('[data-native-chat-scroll]')
      const loadEarlier = orcaPage.getByRole('button', { name: 'Load earlier messages' })
      await expect(orcaPage.locator('[data-native-chat-window]')).toBeVisible({ timeout: 30_000 })
      await expect(loadEarlier).toBeAttached({ timeout: 30_000 })
      // A reader's wheel detaches the transcript from its end; read up to the oldest loaded rows.
      await scroll.hover()
      for (let step = 0; step < 200; step += 1) {
        if ((await scroll.evaluate((element) => element.scrollTop)) === 0) {
          break
        }
        await orcaPage.mouse.wheel(0, -3_000)
        await nextFrames(orcaPage, 2)
      }
      await settleScroll(scroll)
      const runHeader = orcaPage
        .locator('[data-native-chat-tool-run-state="settled"][aria-expanded="false"]')
        .first()
      await runHeader.click()
      const members = orcaPage.locator(
        '[data-native-chat-tool-run-members] [data-native-chat-content-anchor]'
      )
      await expect.poll(() => members.count()).toBeGreaterThan(0)
      const loadedMembers = await members.count()
      expect(loadedMembers, 'the first window cuts the run').toBeLessThan(RUN_COMMANDS)

      // Park the reader so the run's last loaded command is half above the viewport's top edge.
      const anchor = (await members.last().getAttribute('data-native-chat-content-anchor')) ?? ''
      const command = members.last()
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const miss = await command.evaluate((member) => {
          const rect = member.getBoundingClientRect()
          const top = member.closest('[data-native-chat-scroll]')!.getBoundingClientRect().top
          return rect.top - top + rect.height / 2
        })
        if (Math.abs(miss) < 2) {
          break
        }
        await orcaPage.mouse.wheel(0, miss)
        await settleScroll(scroll)
      }
      const place = (key: string) =>
        scroll.evaluate((root, anchorKey) => {
          const member = root.querySelector(`[data-native-chat-content-anchor="${anchorKey}"]`)
          // The transcript row, not the run's own member row inside it.
          const row = member?.closest('[data-native-chat-row-key]')
          if (!member || !row) {
            return null
          }
          const top = member.getBoundingClientRect().top
          return {
            height: member.getBoundingClientRect().height,
            offset: top - root.getBoundingClientRect().top,
            inset: top - row.getBoundingClientRect().top
          }
        }, key)
      const before = await place(anchor)
      expect(before, 'the command row is mounted').not.toBeNull()
      expect(before!.offset, 'the command starts above the viewport').toBeLessThan(0)
      expect(before!.offset + before!.height, 'and ends inside it').toBeGreaterThan(0)

      await orcaPage.evaluate((anchorKey) => {
        const trace: PrependTrace = { active: true, frames: [] }
        window.__nativeChatPrependTrace = trace
        const sample = () => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => {
            const root = document.querySelector('[data-native-chat-scroll]')
            const member = root?.querySelector(`[data-native-chat-content-anchor="${anchorKey}"]`)
            const top = root?.getBoundingClientRect().top ?? 0
            trace.frames.push({
              content: member ? member.getBoundingClientRect().top - top : null,
              slot: null
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
      }, anchor)
      await loadEarlier.evaluate((button: HTMLButtonElement) => button.click())
      await expect.poll(() => members.count(), { timeout: 30_000 }).toBeGreaterThan(loadedMembers)
      await settleScroll(scroll)

      const after = await place(anchor)
      const frames = await orcaPage.evaluate(() => {
        const trace = window.__nativeChatPrependTrace!
        trace.active = false
        return trace.frames
      })
      expect(after, 'the opened run keeps the command mounted').not.toBeNull()
      expect(
        after!.inset - before!.inset,
        'older commands drew above it inside its row'
      ).toBeGreaterThan(10)
      expect(frames.length).toBeGreaterThan(0)
      expect(
        frames.every((frame) => frame.content !== null),
        'mounted in every frame'
      ).toBe(true)
      expect(
        Math.max(...frames.map((frame) => Math.abs((frame.content ?? Infinity) - before!.offset))),
        'displacement in any painted frame'
      ).toBeLessThanOrEqual(2)

      // Leave the run's range and come back: the transcript redraws it from the virtualizer's sizes,
      // so the space after it must match a neighbour's, with no phantom height left behind.
      const reading = await scroll.evaluate((root) => root.scrollTop)
      // Far enough to unmount the run, short of the end (returning there trims older pages).
      await scroll.evaluate((root, top) => {
        root.scrollTop = top + 4_000
      }, reading)
      await settleScroll(scroll)
      await scroll.evaluate((root, top) => {
        root.scrollTop = top
      }, reading)
      await settleScroll(scroll)
      const gaps = await scroll.evaluate((root, anchorKey) => {
        const run = root
          .querySelector(`[data-native-chat-content-anchor="${anchorKey}"]`)
          ?.closest<HTMLElement>('[data-native-chat-row-key]')
        const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-native-chat-row-key]'))
        const at = run ? rows.indexOf(run) : -1
        const gapAfter = (index: number) =>
          rows[index + 1]!.getBoundingClientRect().top - rows[index]!.getBoundingClientRect().bottom
        return at > 0 && at < rows.length - 1
          ? { run: gapAfter(at), before: gapAfter(at - 1) }
          : null
      }, anchor)
      expect(gaps, 'the run and its neighbours are drawn again').not.toBeNull()
      expect(Math.abs(gaps!.run - gaps!.before), 'space after the run').toBeLessThanOrEqual(1)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  test('keeps content where the wheel put it when an older page lands mid-gesture', async ({
    orcaPage
  }) => {
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
    const sessionId = `e2e-wheel-anchor-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-wheel-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, claudeTranscript(TRANSCRIPT_ROWS, sessionId, true))

    try {
      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      const scroll = orcaPage.locator('[data-native-chat-scroll]')
      const transcriptWindow = orcaPage.locator('[data-native-chat-window]')
      await expect(transcriptWindow).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => transcriptWindow.locator(':scope > [data-index]').count())
        .toBeGreaterThan(3)

      // Read toward the oldest loaded rows with real wheel input, stopping short of auto-loading.
      await scroll.hover()
      for (let step = 0; step < 400; step += 1) {
        const top = await scroll.evaluate((element) => element.scrollTop)
        if (top >= 610 && top <= 800) {
          break
        }
        await orcaPage.mouse.wheel(0, Math.max(-600, Math.min(600, 750 - top)))
        await nextFrames(orcaPage, 2)
      }
      await settleScroll(scroll)
      const before = await scroll.evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight
      }))
      expect(before.top, 'reader parks outside the auto-load band').toBeGreaterThanOrEqual(610)
      const anchor = await scroll.evaluate((element) => {
        const viewport = element.getBoundingClientRect()
        const marker = Array.from(element.querySelectorAll('p'))
          .filter((paragraph) => /^E2E transcript row \d{4}$/.test(paragraph.textContent ?? ''))
          .filter((paragraph) => {
            const rect = paragraph.getBoundingClientRect()
            return rect.bottom > viewport.top && rect.top < viewport.bottom
          })
          .sort(
            (left, right) =>
              Math.abs(left.getBoundingClientRect().top - viewport.top) -
              Math.abs(right.getBoundingClientRect().top - viewport.top)
          )[0]
        return marker
          ? {
              text: marker.textContent ?? '',
              offset: marker.getBoundingClientRect().top - viewport.top
            }
          : null
      })
      expect(anchor, 'a visible row marker to follow').not.toBeNull()
      if (!anchor) {
        throw new Error('Expected a visible row marker')
      }

      // Keep scrolling up into the auto-load band; the older page lands while the gesture continues.
      const deltas = [80, 60, 40, 20, 10]
      for (const delta of deltas) {
        await orcaPage.mouse.wheel(0, -delta)
        await nextFrames(orcaPage, 2)
      }
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollHeight), { timeout: 30_000 })
        .toBeGreaterThan(before.height)
      await settleScroll(scroll)

      const offset = await orcaPage
        .getByText(anchor.text, { exact: true })
        .evaluate(
          (marker) =>
            marker.getBoundingClientRect().top -
            (marker.closest('[data-native-chat-scroll]')?.getBoundingClientRect().top ?? 0)
        )
      const wheeled = deltas.reduce((sum, delta) => sum + delta, 0)
      expect(
        Math.abs(offset - anchor.offset - wheeled),
        `content moved ${offset - anchor.offset}px for ${wheeled}px of wheel input`
      ).toBeLessThanOrEqual(2)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  test('lands a rail jump made while an older page is drawn', async ({ orcaPage }) => {
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
    const sessionId = `e2e-rail-landing-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-rail-'))
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
      // Manual paging, so the page lands exactly when this test asks for it.
      await orcaPage.evaluate(() => {
        Object.defineProperty(window, 'IntersectionObserver', {
          value: undefined,
          configurable: true
        })
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      const scroll = orcaPage.locator('[data-native-chat-scroll]')
      const loadEarlier = orcaPage.getByRole('button', { name: 'Load earlier messages' })
      const ticks = orcaPage.locator('[data-native-chat-rail] button')
      await expect(orcaPage.locator('[data-native-chat-window]')).toBeVisible({ timeout: 30_000 })
      await expect(loadEarlier).toBeAttached({ timeout: 30_000 })
      // The rail shows once the reader leaves the end.
      await scroll.hover()
      await orcaPage.mouse.wheel(0, -3_000)
      await settleScroll(scroll)
      await expect.poll(() => ticks.count(), { timeout: 30_000 }).toBeGreaterThan(3)
      // A prompt the rail offers, a few ticks in.
      const prompt = /E2E transcript row \d{4}/.exec(
        (await ticks.nth(2).getAttribute('aria-label')) ?? ''
      )?.[0]
      expect(prompt, 'a rail tick names its prompt').toBeDefined()
      const target = orcaPage.getByRole('button', { name: new RegExp(`^${prompt!} `) })
      const rowOffset = () =>
        scroll.evaluate((root, text) => {
          const marker = Array.from(root.querySelectorAll('p')).find(
            (paragraph) => paragraph.textContent?.trim() === text
          )
          return marker
            ? marker.getBoundingClientRect().top - root.getBoundingClientRect().top
            : null
        }, prompt!)
      const awayFromTarget = async () => {
        await scroll.hover()
        await orcaPage.mouse.wheel(0, 3_000)
        await settleScroll(scroll)
      }

      // Where a rail jump lands with nothing else going on.
      await target.evaluate((button: HTMLButtonElement) => button.click())
      await settleScroll(scroll)
      const landedAlone = await rowOffset()
      expect(landedAlone, 'the jump reaches its prompt').not.toBeNull()

      // The same jump, made in the same task that starts an older page.
      await awayFromTarget()
      const height = await scroll.evaluate((root) => root.scrollHeight)
      await orcaPage.evaluate((text) => {
        const load = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Load earlier messages'
        )
        const jump = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-native-chat-rail] button')
        ).find((button) => button.getAttribute('aria-label')?.startsWith(`${text} `))
        if (!load || !jump) {
          throw new Error('Load earlier and the rail tick must both be on screen')
        }
        load.click()
        jump.click()
      }, prompt!)
      await expect
        .poll(() => scroll.evaluate((root) => root.scrollHeight), { timeout: 30_000 })
        .toBeGreaterThan(height)
      await settleScroll(scroll)
      const landedWithPage = await rowOffset()
      expect(landedWithPage, 'the jump still reaches its prompt').not.toBeNull()
      expect(Math.abs(landedWithPage! - landedAlone!)).toBeLessThanOrEqual(2)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
