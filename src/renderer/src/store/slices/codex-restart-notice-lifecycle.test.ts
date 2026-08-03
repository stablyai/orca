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

  it('reports which panes are left holding a notice', () => {
    expect(
      useAppStore
        .getState()
        .markCodexRestartNotices([{ ptyId: 'pty-1', previousAccountLabel: A, nextAccountLabel: B }])
    ).toEqual(['pty-1'])

    // Why the caller needs this: the startup sweep suppresses a pane for the
    // rest of the session once it is told a prompt went up.
    expect(
      useAppStore
        .getState()
        .markCodexRestartNotices([{ ptyId: 'pty-1', previousAccountLabel: B, nextAccountLabel: A }])
    ).toEqual([])
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

// Why: doAddAccount has no duplicate-email check, so one OpenAI login used in
// two ChatGPT workspaces gives two accounts the same label — as does a failed
// roster read, which collapses every account to 'Codex account'.
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

  it('does not collapse an equal-account home-route change', () => {
    useAppStore.getState().markCodexRestartNotices([
      {
        ptyId: 'pty-1',
        previousAccountLabel: 'System default',
        nextAccountLabel: 'System default',
        previousAccountId: null,
        nextAccountId: null,
        homeRouteChanged: true
      }
    ])

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: 'System default',
      nextAccountLabel: 'System default',
      previousAccountId: null,
      nextAccountId: null,
      homeRouteChanged: true
    })
  })

  it('re-asks a dismissed pane when a same-labelled third account is selected', () => {
    switchAccountById('pty-1', 'account-a', 'account-b')
    useAppStore.getState().dismissCodexRestartNotices(['pty-1'])

    switchAccountById('pty-1', 'account-b', 'account-c')

    // Why: carrying the dismissal on the shared label would strand the pane on
    // account-a with its prompt answered for an account it never moved to.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: SHARED,
      nextAccountLabel: SHARED,
      previousAccountId: 'account-a',
      nextAccountId: 'account-c'
    })
  })

  it('puts a failed accepted restart back to the unanswered prompt', () => {
    switchAccount('pty-1', A, B)
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    useAppStore.getState().reopenCodexRestartPrompt('pty-1')

    // Why: the executor could not run the restart, so the pane must show the
    // question again rather than stay muted behind an answered prompt.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: A,
      nextAccountLabel: B
    })
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
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
