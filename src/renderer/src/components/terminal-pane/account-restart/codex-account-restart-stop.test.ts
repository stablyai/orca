import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexAccountRestartStopResult } from '../../../../../shared/agent-accounts/codex/codex-account-restart-stop'

type NoticeTargets = Record<string, { nextAccountId?: string | null; generation?: number }>
type StoreState = {
  clearCodexRestartNotice: ReturnType<typeof vi.fn>
  reopenCodexRestartPrompt: ReturnType<typeof vi.fn>
  codexRestartNoticeByPtyId: NoticeTargets
  ptyIdsByTabId: Record<string, string[]>
}

const { store } = vi.hoisted((): { store: StoreState } => ({
  store: {
    clearCodexRestartNotice: vi.fn(),
    reopenCodexRestartPrompt: vi.fn(),
    codexRestartNoticeByPtyId: {},
    ptyIdsByTabId: {}
  }
}))
const { listeners } = vi.hoisted((): { listeners: Set<() => void> } => ({ listeners: new Set() }))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => store,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))
const { sleep } = vi.hoisted(() => ({
  sleep: { pane: vi.fn(), undo: vi.fn() }
}))
vi.mock('./codex-account-restart-sleep', () => ({
  sleepPaneForAccountRestart: (...args: unknown[]) => {
    sleep.pane(...args)
    return sleep.undo
  }
}))
const notifyStore = (): void => {
  for (const listener of listeners) {
    listener()
  }
}

import {
  _testing,
  releaseCodexAccountRestartRefusal,
  stopCodexPaneForAccountRestart,
  withdrawCodexPaneAccountRestart
} from './codex-account-restart-stop'

const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'leaf', ptyId: 'pty-a' }

function heldReplies() {
  const replies: ((result: CodexAccountRestartStopResult) => void)[] = []
  const stop = vi.fn(
    () =>
      new Promise<CodexAccountRestartStopResult>((resolve) => {
        replies.push(resolve)
      })
  )
  const withdraw = vi.fn(async () => true)
  const releasePane = vi.fn(async () => {})
  vi.stubGlobal('window', {
    api: {
      pty: {
        stopCodexForAccountRestart: stop,
        withdrawCodexAccountRestart: withdraw,
        releaseCodexAccountRestartPane: releasePane
      }
    }
  })
  return { replies, stop, withdraw, releasePane }
}

describe('renderer account restart stop', () => {
  let opCounter = 0
  beforeEach(() => {
    opCounter = 0
    _testing.setOpIdMinter(() => `op-${++opCounter}`)
    store.clearCodexRestartNotice.mockClear()
    store.reopenCodexRestartPrompt.mockClear()
    store.codexRestartNoticeByPtyId = { 'pty-a': { nextAccountId: 'account-b', generation: 1 } }
    store.ptyIdsByTabId = { tab: ['pty-a'] }
  })
  afterEach(() => {
    _testing.reset()
    vi.unstubAllGlobals()
  })

  it('sleeps the pane before sending the stop, and keeps that sleep only for a stop that ran', async () => {
    sleep.pane.mockClear()
    sleep.undo.mockClear()
    const { replies, stop } = heldReplies()
    const stopped = stopCodexPaneForAccountRestart(pane)
    // The wake reads this record after the exit retires the pane's live agent row.
    expect(sleep.pane).toHaveBeenCalledWith(pane)
    expect(sleep.pane.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]!)
    replies[0]({ outcome: 'stopped', opIds: ['op-1'] })
    await stopped
    expect(sleep.undo).toHaveBeenLastCalledWith(true)
    const refused = stopCodexPaneForAccountRestart(pane)
    replies[1]({ outcome: 'not-started', reason: 'refused', opIds: ['op-2'] })
    await refused
    expect(sleep.undo).toHaveBeenLastCalledWith(false)
  })

  it('applies one joined reply to the current notice once', async () => {
    const { replies } = heldReplies()
    const first = stopCodexPaneForAccountRestart(pane)
    const second = stopCodexPaneForAccountRestart(pane)
    // Main joins both clicks to one stop, so both replies carry both ids.
    replies[0]({ outcome: 'stopped', opIds: ['op-1', 'op-2'] })
    replies[1]({ outcome: 'stopped', opIds: ['op-1', 'op-2'] })
    await expect(first).resolves.toBe('handled')
    await expect(second).resolves.toBe('handled')
    expect(store.clearCodexRestartNotice).toHaveBeenCalledTimes(1)
    expect(store.clearCodexRestartNotice).toHaveBeenCalledWith('pty-a')
    expect(store.reopenCodexRestartPrompt).not.toHaveBeenCalled()
  })

  it('drops a late reply after Dismiss and withdraws that operation in main', async () => {
    const { replies, withdraw } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    withdrawCodexPaneAccountRestart('pty-a')
    expect(withdraw).toHaveBeenCalledWith({
      worktreeId: 'wt',
      tabId: 'tab',
      leafId: 'leaf',
      opId: 'op-1'
    })
    replies[0]({ outcome: 'stopped', opIds: ['op-1'] })
    await pending
    expect(store.clearCodexRestartNotice).not.toHaveBeenCalled()
    expect(store.reopenCodexRestartPrompt).not.toHaveBeenCalled()
  })

  it('a reply for an older click does not settle a newer notice', async () => {
    const { replies } = heldReplies()
    const older = stopCodexPaneForAccountRestart(pane)
    const newer = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'not-started', reason: 'withdrawn', opIds: ['op-1'] })
    await older
    expect(store.reopenCodexRestartPrompt).not.toHaveBeenCalled()
    replies[1]({ outcome: 'stopped', opIds: ['op-2'] })
    await newer
    expect(store.clearCodexRestartNotice).toHaveBeenCalledTimes(1)
  })

  it('turns the prompt manual when the stop did not prove the process ended', async () => {
    const { replies } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'unknown', opIds: ['op-1'] })
    await pending
    expect(store.reopenCodexRestartPrompt).toHaveBeenCalledWith('pty-a', 'manual')
  })

  it('hands lanes main cannot stop back to the replacement restart', async () => {
    const { replies } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'not-started', reason: 'unsupported', opIds: ['op-1'] })
    await expect(pending).resolves.toBe('fallback')
    expect(store.reopenCodexRestartPrompt).not.toHaveBeenCalled()
  })

  it('turns the prompt manual for an outdated local terminal service', async () => {
    const { replies } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'not-started', reason: 'service-outdated', opIds: ['op-1'] })
    await expect(pending).resolves.toBe('handled')
    expect(store.reopenCodexRestartPrompt).toHaveBeenCalledWith('pty-a', 'manual')
  })

  it('never falls back to an unfenced replacement for a legacy pane id', async () => {
    const { replies } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'not-started', reason: 'invalid', opIds: ['op-1'] })
    await expect(pending).resolves.toBe('handled')
    expect(store.reopenCodexRestartPrompt).toHaveBeenCalledWith('pty-a', 'manual')
  })

  it('a Dismiss with no operation in flight sends nothing', () => {
    const { withdraw } = heldReplies()
    withdrawCodexPaneAccountRestart('pty-a')
    expect(withdraw).not.toHaveBeenCalled()
  })

  it('withdraws the answer when its prompt changes target, and ignores its late reply', async () => {
    const { replies, withdraw } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    // The user selects C while the B request is in flight: a new question.
    store.codexRestartNoticeByPtyId = { 'pty-a': { nextAccountId: 'account-c', generation: 2 } }
    notifyStore()
    expect(withdraw).toHaveBeenCalledWith({
      worktreeId: 'wt',
      tabId: 'tab',
      leafId: 'leaf',
      opId: 'op-1'
    })
    replies[0]({ outcome: 'not-started', reason: 'withdrawn', opIds: ['op-1'] })
    await expect(pending).resolves.toBe('handled')
    expect(store.reopenCodexRestartPrompt).not.toHaveBeenCalled()
    expect(store.clearCodexRestartNotice).not.toHaveBeenCalled()
  })

  it('B then A then B: the old B reply cannot settle the new B prompt', async () => {
    const { replies, withdraw } = heldReplies()
    const first = stopCodexPaneForAccountRestart(pane)
    // A clears the prompt; B asks again under a new generation.
    store.codexRestartNoticeByPtyId = {}
    notifyStore()
    store.codexRestartNoticeByPtyId = { 'pty-a': { nextAccountId: 'account-b', generation: 3 } }
    notifyStore()
    expect(withdraw).toHaveBeenCalledTimes(1)
    const second = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'not-started', reason: 'refused', opIds: ['op-1'] })
    await first
    expect(store.reopenCodexRestartPrompt).not.toHaveBeenCalled()
    replies[1]({ outcome: 'stopped', opIds: ['op-2'] })
    await second
    expect(store.clearCodexRestartNotice).toHaveBeenCalledTimes(1)
  })

  it('keeps a retryable refusal answerable instead of manual', async () => {
    const { replies } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'not-started', reason: 'superseded', opIds: ['op-1'] })
    await pending
    expect(store.reopenCodexRestartPrompt).toHaveBeenCalledWith('pty-a')
  })

  it('dismissing the failed resume releases only the refusal of the stop that ran', async () => {
    const { replies, releasePane } = heldReplies()
    const stopped = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'stopped', opIds: ['op-1'] })
    await stopped
    releaseCodexAccountRestartRefusal('Something else failed.', 'wt', 'tab', 'leaf')
    expect(releasePane).not.toHaveBeenCalled()
    const refusal = "Couldn't resume on the new account. Restart the pane to try again."
    releaseCodexAccountRestartRefusal(refusal, 'wt', 'tab', 'leaf')
    // Main releases only a refusal that stop caused; a newer stop's refusal names other operations.
    expect(releasePane).toHaveBeenCalledWith({
      worktreeId: 'wt',
      tabId: 'tab',
      leafId: 'leaf',
      opIds: ['op-1']
    })
    // A second, late Dismiss names nothing, so it cannot release a later refusal.
    releaseCodexAccountRestartRefusal(refusal, 'wt', 'tab', 'leaf')
    expect(releasePane).toHaveBeenLastCalledWith({
      worktreeId: 'wt',
      tabId: 'tab',
      leafId: 'leaf',
      opIds: []
    })
  })

  it("the accepted stop's own exit removing the notice is not a withdrawal", async () => {
    const { replies, withdraw } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    // The restart exit unbinds the stopped process from the pane and its notice goes with it.
    store.ptyIdsByTabId = { tab: [] }
    store.codexRestartNoticeByPtyId = {}
    notifyStore()
    expect(withdraw).not.toHaveBeenCalled()
    replies[0]({ outcome: 'stopped', opIds: ['op-1'] })
    await pending
    expect(store.clearCodexRestartNotice).toHaveBeenCalledWith('pty-a')
  })
})
