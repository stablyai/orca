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
  it('keeps a queued Claude restart through Codex notice clear, dismiss and settle', () => {
    const pending = (): string | undefined =>
      useAppStore.getState().pendingPaneAccountRestarts['pty-1']
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'claude')

    switchAccount('pty-1', A, B)
    useAppStore.getState().clearCodexRestartNotice('pty-1')
    expect(pending()).toBe('claude')

    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])
    expect(pending()).toBe('claude')

    switchAccount('pty-1', B, A)
    expect(pending()).toBe('claude')
  })

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

    // Pane remains on launch account A through later B→C switches; never hide that mismatch.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: C
    })
  })

  it('leaves a dismissal answered when the active account is re-marked unchanged', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    // Add/reauth with unchanged selection must not revive dismissed prompts and reblock freed keyboards.
    switchAccount('pty-1', B, B)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      dismissed: true
    })
  })

  it('drops a queued restart when the user dismisses the same pane', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'codex')

    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B,
      dismissed: true
    })
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })

  it('re-blocks a dismissed pane once a restart is queued for it', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'codex')

    // Until relaunch pane still runs A; dismissal cannot survive a new restart request.
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

  it('reports which panes are left holding a notice', () => {
    expect(
      useAppStore
        .getState()
        .markCodexRestartNotices([{ ptyId: 'pty-1', previousAccountLabel: A, nextAccountLabel: B }])
    ).toEqual(['pty-1'])

    // Report whether prompt appeared; startup suppresses further offers after success.
    expect(
      useAppStore
        .getState()
        .markCodexRestartNotices([{ ptyId: 'pty-1', previousAccountLabel: B, nextAccountLabel: A }])
    ).toEqual([])
  })

  it('still deletes the record when the pane actually restarts', () => {
    switchAccount('pty-1', A, B)

    // Successful relaunch resets launch identity to B so later B→A switches can prompt.
    useAppStore.getState().clearCodexRestartNotice('pty-1')

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
    switchAccount('pty-1', B, A)
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: B,
      nextAccountLabel: A
    })
  })
})

// Same email can name two workspace accounts; failed roster reads also collapse labels to Codex account.
describe('codex restart notices with colliding account labels', () => {
  const SHARED = 'shared@example.com'

  function switchAccountById(ptyId: string, from: string | null, to: string | null): void {
    useAppStore.getState().markCodexRestartNotices([
      {
        ptyId,
        previousAccountLabel: SHARED,
        nextAccountLabel: SHARED,
        previousAccountId: from,
        nextAccountId: to
      }
    ])
  }

  it('raises the prompt for two different accounts that read the same', () => {
    switchAccountById('pty-1', 'account-a', 'account-b')

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: SHARED,
      nextAccountLabel: SHARED,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
  })

  it('still collapses A -> B -> A when the ids match', () => {
    switchAccountById('pty-1', 'account-a', 'account-b')
    switchAccountById('pty-1', 'account-b', 'account-a')

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
  })

  it('collapses back to the system default the pane launched under', () => {
    switchAccountById('pty-1', null, 'account-b')
    switchAccountById('pty-1', 'account-b', null)

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
  })

  it('re-asks a dismissed pane when a same-labelled third account is selected', () => {
    switchAccountById('pty-1', 'account-a', 'account-b')
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    switchAccountById('pty-1', 'account-b', 'account-c')

    // Shared-label dismissal must not strand account-a with a prompt answered for another account.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: SHARED,
      nextAccountLabel: SHARED,
      previousAccountId: 'account-a',
      nextAccountId: 'account-c'
    })
  })

  it('puts a failed accepted restart back to the unanswered prompt', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().queuePaneAccountRestarts(['pty-1'], 'codex')

    useAppStore.getState().reopenCodexRestartPrompt('pty-1')

    // Failed executor must reoffer restart instead of retaining answered/muted state.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B
    })
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
  })

  it('leaves unanswered and dismissed notices alone on a reopen request', () => {
    switchAccount('pty-1', A, B)
    const unanswered = useAppStore.getState().codexRestartNoticeByPtyId

    useAppStore.getState().reopenCodexRestartPrompt('pty-1')
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toBe(unanswered)

    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])
    const dismissed = useAppStore.getState().codexRestartNoticeByPtyId
    useAppStore.getState().reopenCodexRestartPrompt('pty-1')
    expect(useAppStore.getState().codexRestartNoticeByPtyId).toBe(dismissed)
  })
})

describe('replaceTerminalLayoutPanePtyId', () => {
  const LEAF = '11111111-1111-4111-8111-111111111111'

  it('rebinds one leaf and leaves split siblings alone', () => {
    const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: null,
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-old', [OTHER_LEAF]: 'pty-sibling' }
        }
      }
    })

    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab-1', LEAF, 'pty-new')

    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toEqual({
      [LEAF]: 'pty-new',
      [OTHER_LEAF]: 'pty-sibling'
    })
  })

  it('does nothing for a tab with no layout', () => {
    const before = useAppStore.getState().terminalLayoutsByTabId
    useAppStore.getState().replaceTerminalLayoutPanePtyId('tab-none', LEAF, 'pty-new')
    expect(useAppStore.getState().terminalLayoutsByTabId).toBe(before)
  })
})
