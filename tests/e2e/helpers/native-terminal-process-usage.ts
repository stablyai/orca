import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { waitForPtyShellEcho } from '../terminal-pty-readiness'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  splitNativeTerminalPane
} from './native-terminal-debug'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './terminal'

// Shared by the native terminal benchmarks: per-process usage from proc_pid_rusage (CPU time
// and instructions rather than wall time, so a loaded machine skews them little; timer
// wakeups; footprint), the addon's idle counters, and the tabs and panes they measure.
// Ghostty runs on threads of the main (Browser) process.

export type TerminalMode = 'xterm' | 'native'
export type ProcessKind = 'main' | 'renderer' | 'gpu' | 'other'

type ProcessUsage = {
  userNs: number
  systemNs: number
  interruptWakeups: number
  idleWakeups: number
  instructions: number
  cycles: number
  footprint: number
}

export type UsageSnapshot = {
  at: number
  processes: { pid: number; kind: ProcessKind; usage: ProcessUsage }[]
}

export type CpuMsByKind = { main: number; renderer: number; gpu: number; total: number }

export type IdleRates = {
  cpuMsPerS: number
  wakeupsPerS: number
  instructionsPerS: number
}

export type IdleSample = {
  panes: number
  windowMs: number
  byKind: Record<ProcessKind, IdleRates & { footprintMb: number }>
  counters: { ticksPerS: number; setFramesPerS: number; presentedFramesPerS: number } | null
}

export async function usageSnapshot(app: ElectronApplication): Promise<UsageSnapshot> {
  return app.evaluate(({ app: electronApp }) => {
    const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
    const read: unknown =
      typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'processUsage') : null
    if (typeof read !== 'function') {
      throw new Error('native terminal processUsage debug hook is not installed')
    }
    const processes: { pid: number; kind: ProcessKind; usage: ProcessUsage }[] = []
    for (const metric of electronApp.getAppMetrics()) {
      const usage: unknown = Reflect.apply(read, debug, [metric.pid])
      if (typeof usage !== 'object' || usage === null) {
        continue
      }
      const kind: ProcessKind =
        metric.type === 'Browser'
          ? 'main'
          : metric.type === 'Tab'
            ? 'renderer'
            : metric.type === 'GPU'
              ? 'gpu'
              : 'other'
      processes.push({
        pid: metric.pid,
        kind,
        usage: {
          userNs: Number(Reflect.get(usage, 'userNs')),
          systemNs: Number(Reflect.get(usage, 'systemNs')),
          interruptWakeups: Number(Reflect.get(usage, 'interruptWakeups')),
          idleWakeups: Number(Reflect.get(usage, 'idleWakeups')),
          instructions: Number(Reflect.get(usage, 'instructions')),
          cycles: Number(Reflect.get(usage, 'cycles')),
          footprint: Number(Reflect.get(usage, 'footprint'))
        }
      })
    }
    return { at: performance.timeOrigin + performance.now(), processes }
  })
}

export async function nativeCounters(
  app: ElectronApplication
): Promise<{ ticks: number; setFrames: number; presentedFrames: number; surfaces: number } | null> {
  const value: unknown = await app.evaluate(() => {
    const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
    const read: unknown =
      typeof debug === 'object' && debug !== null ? Reflect.get(debug, 'counters') : null
    return typeof read === 'function' ? Reflect.apply(read, debug, []) : null
  })
  if (typeof value !== 'object' || value === null) {
    return null
  }
  return {
    ticks: Number(Reflect.get(value, 'ticks')),
    setFrames: Number(Reflect.get(value, 'setFrames')),
    presentedFrames: Number(Reflect.get(value, 'presentedFrames')),
    surfaces: Number(Reflect.get(value, 'surfaces'))
  }
}

function cpuMs(usage: ProcessUsage): number {
  return (usage.userNs + usage.systemNs) / 1e6
}

function emptyRates(): IdleRates & { footprintMb: number } {
  return { cpuMsPerS: 0, wakeupsPerS: 0, instructionsPerS: 0, footprintMb: 0 }
}

// CPU milliseconds per process kind between two snapshots, for processes alive in both.
export function cpuMsBetween(before: UsageSnapshot, after: UsageSnapshot): CpuMsByKind {
  const byKind: CpuMsByKind = { main: 0, renderer: 0, gpu: 0, total: 0 }
  for (const process of after.processes) {
    const previous = before.processes.find((candidate) => candidate.pid === process.pid)
    if (!previous) {
      continue
    }
    const ms = cpuMs(process.usage) - cpuMs(previous.usage)
    byKind.total += ms
    if (process.kind !== 'other') {
      byKind[process.kind] += ms
    }
  }
  return byKind
}

// Rates between two snapshots for processes alive in both; footprint is the later reading.
export function idleRatesBetween(
  before: UsageSnapshot,
  after: UsageSnapshot
): Record<ProcessKind, IdleRates & { footprintMb: number }> {
  const seconds = (after.at - before.at) / 1000
  const byKind: Record<ProcessKind, IdleRates & { footprintMb: number }> = {
    main: emptyRates(),
    renderer: emptyRates(),
    gpu: emptyRates(),
    other: emptyRates()
  }
  for (const process of after.processes) {
    const previous = before.processes.find((candidate) => candidate.pid === process.pid)
    if (!previous) {
      continue
    }
    const rates = byKind[process.kind]
    const { usage } = process
    rates.cpuMsPerS += (cpuMs(usage) - cpuMs(previous.usage)) / seconds
    rates.wakeupsPerS += (usage.interruptWakeups - previous.usage.interruptWakeups) / seconds
    rates.instructionsPerS += (usage.instructions - previous.usage.instructions) / seconds
    rates.footprintMb += usage.footprint / (1024 * 1024)
  }
  return byKind
}

export async function measureIdleWindow(
  app: ElectronApplication,
  page: Page,
  panes: number,
  windowMs: number
): Promise<IdleSample> {
  const countersBefore = await nativeCounters(app)
  const before = await usageSnapshot(app)
  await page.waitForTimeout(windowMs)
  const after = await usageSnapshot(app)
  const countersAfter = await nativeCounters(app)
  const seconds = (after.at - before.at) / 1000
  return {
    panes,
    windowMs: after.at - before.at,
    byKind: idleRatesBetween(before, after),
    counters:
      countersBefore && countersAfter
        ? {
            ticksPerS: (countersAfter.ticks - countersBefore.ticks) / seconds,
            setFramesPerS: (countersAfter.setFrames - countersBefore.setFrames) / seconds,
            presentedFramesPerS:
              (countersAfter.presentedFrames - countersBefore.presentedFrames) / seconds
          }
        : null
  }
}

// A new terminal tab in the active worktree, made active.
export async function openTerminalTab(page: Page): Promise<string> {
  const tabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('no active worktree for a benchmark tab')
    }
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', worktreeId)
    return tab.id
  })
  await expect
    .poll(async () => page.evaluate(() => window.__store?.getState().activeTabId))
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  return tabId
}

// Adds one pane by splitting the active one, alternating directions toward a grid.
export async function addTerminalPane(
  page: Page,
  app: ElectronApplication,
  mode: TerminalMode,
  paneCount: number
): Promise<void> {
  const direction = paneCount % 2 === 1 ? 'vertical' : 'horizontal'
  if (mode === 'native' && direction === 'vertical') {
    await splitNativeTerminalPane(page, app)
    return
  }
  const previous = await waitForActivePanePtyId(page)
  await splitActiveTerminalPane(page, direction)
  await waitForActiveTerminalManager(page, 30_000)
  let ptyId = previous
  await expect
    .poll(async () => (ptyId = await waitForActivePanePtyId(page)), { timeout: 15_000 })
    .not.toBe(previous)
  await waitForPtyShellEcho(page, ptyId, 30_000)
  if (mode === 'native') {
    expect(await findNativeSurfaceForPane(page, ptyId)).not.toBeNull()
  }
}

export async function setTerminalMode(page: Page, mode: TerminalMode): Promise<void> {
  await enableNativeTerminal(page, mode === 'native')
}

// GPU memory the process owns but has not mapped, where Metal keeps its working pool.
export function metalWorkingPoolMb(pid: number): number {
  const report = memoryReport(pid).footprint ?? ''
  const line = report
    .split('\n')
    .find((row) => row.endsWith('Owned physical footprint (unmapped) (graphics)'))
  const dirty = line ? /^\s*([\d.]+) (B|KB|MB|GB)/.exec(line) : null
  if (!dirty) {
    return 0
  }
  const scale: Record<string, number> = { B: 1 / (1024 * 1024), KB: 1 / 1024, MB: 1, GB: 1024 }
  return Number.parseFloat(dirty[1]) * (scale[dirty[2]] ?? 0)
}

// vmmap/footprint category summaries for one process; null when the tool cannot read it.
export function memoryReport(pid: number): { vmmap: string | null; footprint: string | null } {
  const run = (command: string, args: string[]): string | null => {
    try {
      return execFileSync(command, args, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 64 << 20
      })
    } catch (error) {
      const stdout: unknown =
        typeof error === 'object' && error !== null ? Reflect.get(error, 'stdout') : null
      return typeof stdout === 'string' && stdout.length > 0 ? stdout : null
    }
  }
  return {
    vmmap: run('vmmap', ['--summary', String(pid)]),
    footprint: run('footprint', ['-p', String(pid)])
  }
}
