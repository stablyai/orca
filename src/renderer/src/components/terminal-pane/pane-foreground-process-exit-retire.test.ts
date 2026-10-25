import { describe, expect, it, vi } from 'vitest'
import { resolveTitleDerivedPaneAgent } from '../sidebar/title-derived-pane-agent-identity'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  createDeferred,
  flushAsyncTicks,
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'

// Wires the pane's tracker and completion monitor the way pane-agent-identity.ts and
// terminal-keydown-fit.ts do, for a pane whose shell emits no OSC 133 command marks.
function createUnmarkedPane(args: { visible: boolean }) {
  let entry: PaneForegroundAgentEntry | undefined
  let foreground: string | null = 'codex'
  let hasChildren = true
  const readForegroundProcess = vi.fn(async (): Promise<string | null> => foreground)
  const confirmForegroundProcess = vi.fn(async (): Promise<string | null> => foreground)
  const onConfirmedShellForeground = vi.fn()
  let coordinator: ReturnType<typeof createAgentCompletionCoordinator> | null = null
  const tracker = createPaneForegroundAgentTracker({
    getPtyId: () => 'pty-1',
    isTrackablePtyId: () => true,
    readForegroundProcess,
    confirmForegroundProcess,
    publish: (next) => {
      entry = next
    },
    getPublishedEntry: () => entry,
    onAgentProcessRead: (process) => coordinator?.observeForegroundAgentProcess(process),
    onConfirmedShellForeground
  })
  coordinator = createAgentCompletionCoordinator({
    paneKey: 'tab-1:leaf-1',
    statusLane: 'pty',
    getPtyId: () => 'pty-1',
    inspectProcess: vi.fn(async () => processResult(foreground, hasChildren)),
    dispatchCompletion: vi.fn(),
    isLive: () => true,
    shouldPollProcessCadence: () => args.visible,
    onForegroundAgentExited: (exited) => tracker.onProcessExitConfirmed(exited)
  })
  coordinator.startProcessTracking()
  return {
    tracker,
    onConfirmedShellForeground,
    getEntry: () => entry,
    setEntry: (next: PaneForegroundAgentEntry) => {
      entry = next
    },
    setForeground: (processName: string | null, children: boolean) => {
      foreground = processName
      hasChildren = children
    },
    confirmForegroundProcess
  }
}

function sidebarAgent(title: string, entry: PaneForegroundAgentEntry | undefined) {
  return resolveTitleDerivedPaneAgent({
    title,
    defaultTitle: 'Terminal 2',
    titleShowsActivity: false,
    titleAgentType: null,
    launchAgentType: null,
    foreground: entry
  })
}

describe('process monitor retires a latched foreground read', () => {
  useAgentCompletionCoordinatorLifecycle()

  it('drops the row after Codex exits and the shell titles its prompt', async () => {
    const pane = createUnmarkedPane({ visible: true })
    pane.tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(sidebarAgent('repo', pane.getEntry())).toBe('codex')

    pane.setForeground('zsh', false)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(pane.getEntry()).toEqual({ agent: null, shellForeground: false })
    expect(pane.onConfirmedShellForeground).toHaveBeenCalledWith('process-exit')
    expect(sidebarAgent('', pane.getEntry())).toBeNull()
    expect(sidebarAgent('user@host: ~/repo', pane.getEntry())).toBeNull()
  })

  it('drops the row when a killed Codex leaves its last title behind', async () => {
    const pane = createUnmarkedPane({ visible: true })
    pane.tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(2_500)

    pane.setForeground('zsh', false)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sidebarAgent('repo', pane.getEntry())).toBeNull()
  })

  it('keeps the row while Codex runs a nested shell', async () => {
    const pane = createUnmarkedPane({ visible: true })
    pane.tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(2_500)

    pane.setForeground('zsh', true)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(sidebarAgent('repo', pane.getEntry())).toBe('codex')
    expect(pane.onConfirmedShellForeground).not.toHaveBeenCalled()
  })

  it('watches a hidden pane once its process read names the agent', async () => {
    const pane = createUnmarkedPane({ visible: false })
    pane.tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(400)
    expect(sidebarAgent('repo', pane.getEntry())).toBe('codex')

    pane.setForeground('zsh', false)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(sidebarAgent('repo', pane.getEntry())).toBeNull()
  })

  it('leaves an in-flight command-finished read to decide the pane', async () => {
    const pane = createUnmarkedPane({ visible: true })
    pane.tracker.onVisiblePtyBound()
    await vi.advanceTimersByTimeAsync(2_500)
    const pendingConfirm = createDeferred<string | null>()
    pane.confirmForegroundProcess.mockReturnValueOnce(pendingConfirm.promise)
    pane.tracker.onCommandFinished()
    await vi.advanceTimersByTimeAsync(400)

    pane.tracker.onProcessExitConfirmed({ agent: 'codex', processName: 'codex' })
    await flushAsyncTicks()

    expect(pane.getEntry()).toMatchObject({ agent: 'codex', agentEvidence: 'process-read' })
    expect(pane.onConfirmedShellForeground).not.toHaveBeenCalled()
  })

  it('does not retire a reattach launch record or another agent', () => {
    const pane = createUnmarkedPane({ visible: false })
    const launchRecord: PaneForegroundAgentEntry = {
      agent: 'codex',
      agentEvidence: 'launch-record',
      shellForeground: false
    }
    pane.setEntry(launchRecord)
    pane.tracker.onProcessExitConfirmed({ agent: 'codex', processName: 'codex' })
    expect(pane.getEntry()).toBe(launchRecord)

    const claudeRead: PaneForegroundAgentEntry = {
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    }
    pane.setEntry(claudeRead)
    pane.tracker.onProcessExitConfirmed({ agent: 'codex', processName: 'codex' })
    expect(pane.getEntry()).toBe(claudeRead)
    expect(pane.onConfirmedShellForeground).not.toHaveBeenCalled()
  })
})
