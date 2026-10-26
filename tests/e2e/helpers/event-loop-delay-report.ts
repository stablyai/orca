// Summarize main/orcad event-loop delay windows from the E2E profile’s diagnostic log.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import {
  EVENT_LOOP_DELAY_REPORT_FILE,
  type EventLoopDelayWindow
} from '../../../src/main/diagnostics/event-loop-delay-probe'

export type EventLoopDelaySummary = {
  process: EventLoopDelayWindow['process']
  /** One-second windows overlapping the range. */
  windows: number
  /** Worst window's p99 and the largest single delay, in ms. */
  p99: number
  max: number
}

type ReadWindow = Pick<EventLoopDelayWindow, 'process' | 't' | 'windowMs' | 'p99' | 'max'>

function parseWindow(line: string): ReadWindow | null {
  const value: unknown = JSON.parse(line)
  if (
    !value ||
    typeof value !== 'object' ||
    !('t' in value) ||
    !('windowMs' in value) ||
    !('p99' in value) ||
    !('max' in value) ||
    !('process' in value) ||
    typeof value.t !== 'number' ||
    typeof value.windowMs !== 'number' ||
    typeof value.p99 !== 'number' ||
    typeof value.max !== 'number' ||
    (value.process !== 'main' && value.process !== 'orcad')
  ) {
    return null
  }
  return {
    process: value.process,
    t: value.t,
    windowMs: value.windowMs,
    p99: value.p99,
    max: value.max
  }
}

function readWindows(userDataDir: string): ReadWindow[] {
  const file = path.join(userDataDir, EVENT_LOOP_DELAY_REPORT_FILE)
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        // The last element is '' or a line still being appended.
        .slice(0, -1)
        .flatMap((line) => parseWindow(line) ?? [])
    : []
}

export function summarizeEventLoopDelay(
  userDataDir: string,
  processKind: EventLoopDelayWindow['process'],
  from: number,
  to: number
): EventLoopDelaySummary {
  const windows = readWindows(userDataDir).filter(
    (entry) => entry.process === processKind && entry.t > from && entry.t - entry.windowMs < to
  )
  return {
    process: processKind,
    windows: windows.length,
    p99: Math.max(0, ...windows.map((entry) => entry.p99)),
    max: Math.max(0, ...windows.map((entry) => entry.max))
  }
}

/** The probe writes a window once it closes; wait for the one holding `epochMs`. */
export async function waitForEventLoopDelayWindow(
  userDataDir: string,
  epochMs: number
): Promise<void> {
  await expect
    .poll(() => readWindows(userDataDir).some((entry) => entry.t >= epochMs), {
      timeout: 10_000,
      message: 'the event-loop delay probe wrote no window'
    })
    .toBe(true)
}
