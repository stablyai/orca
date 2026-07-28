import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../index'

const A = 'a@example.com'
const B = 'b@example.com'
const C = 'c@example.com'

function switchAccount(ptyId: string, from: string, to: string): void {
  useAppStore
    .getState()
    .markCodexRestartNotices([{ ptyId, previousAccountLabel: from, nextAccountLabel: to }])
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('codex restart notice lifecycle', () => {
  it('raises no notice when the pane returns to the account it launched under', () => {
    switchAccount('pty-1', A, B)
    switchAccount('pty-1', B, A)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
  })

  it('keeps the launch account after a dismissal so re-selecting it raises no notice', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    switchAccount('pty-1', B, A)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
  })

  it('marks a dismissal instead of erasing the pane record', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      dismissed: true
    })
  })

  it('re-raises the prompt against the pane launch account when a third account is selected', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    switchAccount('pty-1', B, C)

    // Why: over-suppressing here would silently strand the pane on A while the
    // user works under C; the labels must name the launch account, not B.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: C
    })
  })

  it('leaves a dismissal answered when the active account is re-marked unchanged', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    // Why: adding an account and reauthenticating the active one both re-mark
    // live panes with the selection unchanged. Nothing about the pane moved, so
    // resurrecting the prompt would also re-block a keyboard the user freed.
    switchAccount('pty-1', B, B)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      dismissed: true
    })
  })

  it('drops a queued restart when the user dismisses the same pane', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      dismissed: true
    })
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('re-blocks a dismissed pane once a restart is queued for it', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    // Why: the pane still runs under A until it relaunches, so the dismissal
    // that freed its keyboard must not outlive the restart request.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      restartRequested: true
    })
  })

  it('leaves the notice map identity alone when nothing is dismissable', () => {
    switchAccount('pty-1', A, B)
    const before = useAppStore.getState().codexRestartNoticeByPtyId

    useAppStore.getState().dismissCodexRestartNotices(['pty-unknown'])

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toBe(before)
  })

  it('still deletes the record when the pane actually restarts', () => {
    switchAccount('pty-1', A, B)

    // Why: the relaunched pane genuinely runs under B, so its launch-account
    // memory must reset rather than linger and suppress a later B -> A prompt.
    useAppStore.getState().clearCodexRestartNotice('pty-1')

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
    switchAccount('pty-1', B, A)
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: B,
      nextAccountLabel: A
    })
  })
})
