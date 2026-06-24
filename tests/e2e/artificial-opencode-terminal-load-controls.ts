import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ensureTerminalVisible } from './helpers/store'
import {
  ensureTerminalPaneCount,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

export type TerminalLoadPane = {
  paneKey: string
  ptyId: string
}

export type TerminalPtyOutputDebugSnapshot = {
  hiddenRendererSkipCount: number
  hiddenRendererSkippedChars: number
  hiddenRendererMode2031ReplyCount: number
}

export type TerminalOutputSchedulerDebugSnapshot = {
  backgroundEnqueueCount: number
  deferredForegroundEnqueueCount: number
  foregroundWriteCount: number
  backgroundWriteCount: number
  deferredForegroundWriteCount: number
  flushWriteCount: number
  scheduledDrainCount: number
  queuedTerminalCount: number
  queuedChars: number
  peakQueuedTerminalCount: number
  peakQueuedChars: number
  peakQueuedCharsByTerminal: number
  droppedBacklogCount: number
  drainWrites: number[]
}

export type TerminalPtyAckGateSnapshot = {
  gatedPtyCount: number
  heldAckCount: number
  heldAckChars: number
}

export type MainPtyPressureDebugSnapshot = {
  pendingPtyCount: number
  pendingChars: number
  maxPendingCharsByPty: number
  rendererInFlightPtyCount: number
  rendererInFlightChars: number
  maxRendererInFlightCharsByPty: number
  activeRendererPtyCount: number
  sourcePausedPtyCount: number
  inputTrackedPtyCount: number
  latestInputAgeMs: number | null
  flushScheduled: boolean
  peakPendingChars: number
  peakMaxPendingCharsByPty: number
  peakRendererInFlightChars: number
  peakMaxRendererInFlightCharsByPty: number
  ackGatedFlushSkipCount: number
}

type TerminalLoadDebugWindow = Window & {
  __terminalPtyAckGate?: {
    hold: (ptyIds: string[]) => void
    release: () => void
    snapshot: () => TerminalPtyAckGateSnapshot
  }
  __terminalPtyOutputDebug?: {
    reset: () => void
    snapshot: () => TerminalPtyOutputDebugSnapshot
  }
  __terminalOutputSchedulerDebug?: {
    reset: () => void
    snapshot: () => TerminalOutputSchedulerDebugSnapshot
  }
}

export function writeInteractivePromptScript(scriptPath: string, runId: string): void {
  // Why: long scale runs can outlive temporary repo cleanup races in the test
  // harness; the prompt script only needs a writable directory, not git state.
  mkdirSync(path.dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, interactivePromptScript(runId))
}

export async function focusPane(page: Page, paneKey: string): Promise<void> {
  const separator = paneKey.indexOf(':')
  const tabId = paneKey.slice(0, separator)
  const leafId = paneKey.slice(separator + 1)
  await page.evaluate(
    ({ tabId, leafId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getPanes?.().find((candidate) => candidate.leafId === leafId)
      if (!manager || !pane) {
        throw new Error(`Unable to focus pane ${tabId}:${leafId}`)
      }
      manager.setActivePane?.(pane.id, { focus: true })
    },
    { tabId, leafId }
  )
}

export async function ensureActiveWorktreePaneLoad(
  page: Page,
  paneCount: number
): Promise<TerminalLoadPane[]> {
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const initialSnapshot = await waitForPaneIdentitySnapshot(page, 1)
  await ensureTerminalPaneCount(page, initialSnapshot.tabId, paneCount)
  const snapshot = await waitForPaneIdentitySnapshot(page, paneCount)
  return snapshot.panes.slice(0, paneCount).map((pane) => ({
    paneKey: `${snapshot.tabId}:${pane.leafId}`,
    ptyId: pane.ptyId ?? ''
  }))
}

export async function resetTerminalPtyOutputDebug(page: Page): Promise<void> {
  await page.evaluate(async () => {
    ;(window as TerminalLoadDebugWindow).__terminalPtyOutputDebug?.reset()
    ;(window as TerminalLoadDebugWindow).__terminalOutputSchedulerDebug?.reset()
    await window.api.pty.resetRendererDeliveryDebug()
  })
}

export async function readTerminalPtyOutputDebug(
  page: Page
): Promise<TerminalPtyOutputDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as TerminalLoadDebugWindow).__terminalPtyOutputDebug?.snapshot() ?? null
  })
}

export async function readTerminalOutputSchedulerDebug(
  page: Page
): Promise<TerminalOutputSchedulerDebugSnapshot | null> {
  return page.evaluate(() => {
    return (window as TerminalLoadDebugWindow).__terminalOutputSchedulerDebug?.snapshot() ?? null
  })
}

export async function readMainPtyPressureDebug(
  page: Page
): Promise<MainPtyPressureDebugSnapshot | null> {
  return page.evaluate(async () => {
    return window.api.pty.getRendererDeliveryDebugSnapshot()
  })
}

export async function holdTerminalAckGate(page: Page, ptyIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const gate = (window as TerminalLoadDebugWindow).__terminalPtyAckGate
    if (!gate) {
      throw new Error('terminal PTY ACK gate is unavailable')
    }
    gate.hold(ids)
  }, ptyIds)
}

export async function releaseTerminalAckGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as TerminalLoadDebugWindow).__terminalPtyAckGate?.release()
  })
}

export async function readTerminalAckGateDebug(
  page: Page
): Promise<TerminalPtyAckGateSnapshot | null> {
  return page.evaluate(() => {
    return (window as TerminalLoadDebugWindow).__terminalPtyAckGate?.snapshot() ?? null
  })
}

export async function waitForMainPtyPressureBacklog(
  page: Page
): Promise<MainPtyPressureDebugSnapshot> {
  let lastSnapshot: MainPtyPressureDebugSnapshot | null = null
  await expect
    .poll(
      async () => {
        lastSnapshot = await readMainPtyPressureDebug(page)
        const sourcePressureActive = (lastSnapshot?.sourcePausedPtyCount ?? 0) > 0
        return (lastSnapshot?.peakPendingChars ?? 0) > 0 && sourcePressureActive
      },
      {
        timeout: 45_000,
        message: () =>
          `Main PTY source-pause pressure did not build up\n${JSON.stringify(
            lastSnapshot,
            null,
            2
          )}`
      }
    )
    .toBe(true)
  if (!lastSnapshot) {
    throw new Error('Main PTY pressure snapshot unavailable')
  }
  return lastSnapshot
}

function interactivePromptScript(runId: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
let seq = 0
const interrupt = String.fromCharCode(3)
process.stdin.on('data', (chunk) => {
  if (chunk.includes(interrupt)) {
    process.exit(0)
  }
  for (const char of chunk) {
    if (char === '\\r' || char === '\\n') continue
    seq += 1
    process.stdout.write('\\r\\x1b[2KOpenCode load prompt ' + seq + ': ' + char + ' OPENCODE_TYPING_KEY_${runId}_' + seq + '\\n')
  }
})
process.stdout.write('\\x1b]0;OpenCode load typing benchmark\\x07')
process.stdout.write('OPENCODE_TYPING_READY_${runId}\\n')
`
}
