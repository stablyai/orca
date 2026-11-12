import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-foreground-agent'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture(trackable = true) {
  let foreground: string | null = 'sleep'
  const read = vi.fn(async () => foreground)
  const publish = vi.fn<(entry: PaneForegroundAgentEntry) => void>()
  const tracker = createPaneForegroundAgentTracker({
    getPtyId: () => 'pty-delayed',
    isTrackablePtyId: () => trackable,
    readForegroundProcess: read,
    confirmForegroundProcess: read,
    publish
  })
  return {
    tracker,
    read,
    publish,
    foreground: (value: string | null) => {
      foreground = value
    }
  }
}

it('confirms the real process when startup arrives after the command read window', async () => {
  const f = fixture()
  f.tracker.onCommandStarted()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.read).toHaveBeenCalledTimes(3)
  f.foreground('claude')
  f.tracker.onAgentStartupObserved()
  await vi.advanceTimersByTimeAsync(350)
  expect(f.publish).toHaveBeenLastCalledWith({
    agent: 'claude',
    agentEvidence: 'process-read',
    routingTrusted: true,
    shellForeground: false
  })
  expect(f.read).toHaveBeenCalledTimes(4)
  f.tracker.dispose()
})

it('does not cancel an in-flight command confirmation on a startup title', async () => {
  const f = fixture()
  f.tracker.onCommandStarted()
  f.tracker.onAgentStartupObserved()
  f.foreground('codex')
  await vi.advanceTimersByTimeAsync(350)
  expect(f.read).toHaveBeenCalledOnce()
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex' }))
  f.tracker.dispose()
})

it('cancels delayed startup discovery on close', async () => {
  const f = fixture()
  f.tracker.onAgentStartupObserved()
  f.tracker.dispose()
  await vi.advanceTimersByTimeAsync(30_000)
  f.tracker.onAgentStartupObserved()
  expect(f.read).not.toHaveBeenCalled()
})

it('allows the next command to recover after a prior startup miss', async () => {
  const f = fixture()
  f.tracker.onAgentStartupObserved()
  await vi.advanceTimersByTimeAsync(30_000)
  f.tracker.onCommandFinished()
  f.tracker.onCommandStarted()
  await vi.advanceTimersByTimeAsync(30_000)
  f.foreground('gemini')
  f.tracker.onAgentStartupObserved()
  await vi.advanceTimersByTimeAsync(350)
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'gemini' }))
  f.tracker.dispose()
})
