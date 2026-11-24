import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexAccountRestartStopResult } from '../../../../../shared/agent-accounts/codex/codex-account-restart-stop'

type NoticeTargets = Record<string, { nextAccountId?: string | null }>
type StoreState = {
  clearCodexRestartNotice: ReturnType<typeof vi.fn>
  reopenCodexRestartPrompt: ReturnType<typeof vi.fn>
  codexRestartNoticeByPtyId: NoticeTargets
}

const { store } = vi.hoisted((): { store: StoreState } => ({
  store: {
    clearCodexRestartNotice: vi.fn(),
    reopenCodexRestartPrompt: vi.fn(),
    codexRestartNoticeByPtyId: {}
  }
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store } }))

import {
  _testing,
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
  vi.stubGlobal('window', {
    api: { pty: { stopCodexForAccountRestart: stop, withdrawCodexAccountRestart: withdraw } }
  })
  return { replies, stop, withdraw }
}

describe('renderer account restart stop', () => {
  let opCounter = 0
  beforeEach(() => {
    opCounter = 0
    _testing.setOpIdMinter(() => `op-${++opCounter}`)
    store.clearCodexRestartNotice.mockClear()
    store.reopenCodexRestartPrompt.mockClear()
    store.codexRestartNoticeByPtyId = { 'pty-a': { nextAccountId: 'account-b' } }
  })
  afterEach(() => {
    _testing.reset()
    vi.unstubAllGlobals()
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

  it('leaves a newer account switch actionable when an older request is refused', async () => {
    const { replies } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    // B was requested; the user then selected C, which inherited the answered state.
    store.codexRestartNoticeByPtyId = { 'pty-a': { nextAccountId: 'account-c' } }
    replies[0]({ outcome: 'not-started', reason: 'unsupported', opIds: ['op-1'] })
    // Never falls back automatically for a target the user did not confirm.
    await expect(pending).resolves.toBe('handled')
    expect(store.reopenCodexRestartPrompt).toHaveBeenCalledWith('pty-a')
    expect(store.clearCodexRestartNotice).not.toHaveBeenCalled()
  })

  it('keeps a retryable refusal answerable instead of manual', async () => {
    const { replies } = heldReplies()
    const pending = stopCodexPaneForAccountRestart(pane)
    replies[0]({ outcome: 'not-started', reason: 'superseded', opIds: ['op-1'] })
    await pending
    expect(store.reopenCodexRestartPrompt).toHaveBeenCalledWith('pty-a')
  })
})
