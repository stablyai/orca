import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
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

const TRANSCRIPT_ROWS = 650
const RUN_COMMANDS = 8

type PrependTrace = {
  active: boolean
  frames: { content: number | null; slot: number | null }[]
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    __nativeChatPrependTrace?: PrependTrace
  }
}

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({
      nativeChatProviders: { claude: true, codex: true },
      nativeChatAppearance: { fontSize: 13, matchTerminalInterface: false }
    })
    window.__store?.setState({ settings: nextSettings })
  })
}

async function seedClaudeProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e history anchor probe', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
  }, args)
}

async function toggleTerminalTabToChatView(
  page: Page,
  args: { tabId: string; worktreeId: string }
): Promise<void> {
  await page.evaluate(({ tabId, worktreeId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )
    if (!unifiedTab) {
      throw new Error('Unified terminal tab not found for chat toggle')
    }
    state.toggleTabViewMode(unifiedTab.id)
  }, args)
}

async function activateNewTerminalTab(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
  }, worktreeId)
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    state.setActiveTab(id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
  }, tabId)
}

async function publishHiddenLaunchMessage(
  page: Page,
  args: { tabId: string; text: string }
): Promise<void> {
  await page.evaluate(({ tabId, text }) => {
    window.__store?.getState().seedNativeChatLaunchPrompt({
      tabId,
      agent: 'claude',
      text,
      createdAt: Date.now()
    })
  }, args)
}

async function settleScroll(scroll: Locator): Promise<void> {
  await scroll.evaluate(async (element) => {
    let previousGeometry = ''
    let stableFrames = 0
    for (let frame = 0; frame < 180 && stableFrames < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const geometry = `${element.scrollHeight}:${element.scrollTop}`
      stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0
      previousGeometry = geometry
    }
  })
}

async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

/** A prompt, a long stretch of its answer, then a run of commands the first window cuts in two;
 *  the first older page extends the run without reaching the prompt, so the turn stays unfolded. */
function claudeRunTranscript(sessionId: string): string {
  const startedAt = Date.now() - 1_000_000
  let at = 0
  const line = (type: 'user' | 'assistant', content: unknown[]) => {
    at += 1
    return JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${at}`,
      timestamp: new Date(startedAt + at * 1_000).toISOString(),
      type,
      // Records sharing a message id are one message; each record here is its own.
      message: { id: `message-${at}`, role: type, model: 'claude-opus-4', content }
    })
  }
  const text = (type: 'user' | 'assistant', index: number) =>
    line(type, [{ type: 'text', text: `E2E run transcript row ${String(index).padStart(4, '0')}` }])
  const answer = Array.from({ length: 260 }, (_, index) => text('assistant', index))
  const run = Array.from({ length: RUN_COMMANDS }, (_, index) => [
    line('assistant', [
      {
        type: 'tool_use',
        id: `run-${index}`,
        name: 'Bash',
        input: { command: `cat run-${index}.log` }
      }
    ]),
    line('user', [{ type: 'tool_result', tool_use_id: `run-${index}`, content: `run ${index} ok` }])
  ]).flat()
  const newer = Array.from({ length: 296 }, (_, index) =>
    text(index % 2 === 0 ? 'assistant' : 'user', index + 1_000)
  )
  const prompt = line('user', [{ type: 'text', text: 'E2E run prompt' }])
  return `${[prompt, ...answer, ...run, ...newer].join('\n')}\n`
}

function claudeTranscript(rowCount: number, sessionId: string, tools = false): string {
  const startedAt = Date.now() - rowCount * 1_000
  return `${Array.from({ length: rowCount }, (_, index) => {
    const marker = `E2E transcript row ${String(index).padStart(4, '0')}`
    const body = Array.from(
      { length: tools ? 1 + (index % 7) : 5 },
      (_unused, line) => `Measured paragraph ${line + 1} for row ${String(index).padStart(4, '0')}.`
    ).join('\n\n')
    const row = JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${index}`,
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
      type: index % 2 === 0 ? 'user' : 'assistant',
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        model: 'claude-opus-4',
        content: [
          { type: 'text', text: `${marker}\n\n${body}` },
          ...(tools && index % 2 !== 0
            ? [
                {
                  type: 'tool_use',
                  id: `call-${index}`,
                  name: 'Bash',
                  input: { command: `cat row-${index}.log` }
                }
              ]
            : [])
        ]
      }
    })
    return tools && index % 2 !== 0
      ? `${row}\n${JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}-result`,
          timestamp: new Date(startedAt + index * 1_000).toISOString(),
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: `call-${index}`,
                content: 'Output line\n'.repeat(1_500)
              }
            ]
          }
        })}`
      : row
  }).join('\n')}\n`
}

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
