import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { selectCodexStaleSessionCount } from '@/components/status-bar/codex-restart-status-summary'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import { installPtyInputForward } from '../pty-connection/input/pty-input-forward'

vi.mock('@/lib/agent-session/accounts/agent-account-restart-startup', () => ({
  captureAgentAccountRestartResumeInput: () => null,
  buildPaneAccountRestartStartup: () => ({ command: 'codex', launchAgent: 'codex' })
}))
const leaf = '00000000-0000-4000-8000-000000000001'
const sibling = '00000000-0000-4000-8000-000000000002'

function input(ptyId: string, leafId = leaf, incarnationId = 'inc-old') {
  const writes: string[] = [],
    replies: string[] = []
  const noop = () => {}
  const session = {
    remotePtyIncarnationId: incarnationId,
    pane: { id: 1, leafId, terminal: { onData: () => ({ dispose: noop }) } },
    deps: { tabId: 'tab', worktreeId: 'wt', replayingPanesRef: { current: new Map() } },
    transport: {
      getPtyId: () => ptyId,
      sendInput: (data: string) => {
        writes.push(data)
        return true
      }
    },
    sendDesktopQueryReplyImmediate: (data: string) => replies.push(data),
    clearPendingTerminalInputIntent: noop,
    noteTerminalInputForPty: noop,
    pendingTerminalInputIntentFor: () => undefined,
    inferIntentFromExactTerminalInput: () => undefined,
    claimViewportForUserActivity: noop,
    markAcceptedTerminalInputSent: noop,
    observeAcceptedShellCommandInput: noop,
    observeAcceptedTerminalInput: noop,
    observeSentTerminalInputIntent: noop,
    requestRecoveryForUndeliverableInput: noop,
    forwardPtyInput: (_data: string, _wasUserInput?: boolean) => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the ordinary input and protocol-reply routes used here.
  installPtyInputForward(session as never)
  return { type: (data: string) => session.forwardPtyInput(data, true), writes, replies }
}
function failCurrent() {
  useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
  const request = useAppStore.getState().claimCodexAccountRestart(`tab:${leaf}`)
  if (!request) {
    throw new Error('request not accepted')
  }
  useAppStore
    .getState()
    .updateCodexAccountRestart(codexAccountRestartToken(request), { phase: 'failed' })
  useAppStore.getState().clearCodexRestartNotice('old')
}
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.stubGlobal('window', { api: { pty: { noteUserInput: vi.fn() } } })
  useAppStore.setState({
    tabsByWorktree: {
      wt: [
        {
          id: 'tab',
          worktreeId: 'wt',
          createdAt: 1,
          ptyId: 'old',
          title: 'Codex',
          customTitle: null,
          color: null,
          sortOrder: 0
        }
      ]
    },
    ptyIdsByTabId: { tab: ['old', 'sibling'] },
    terminalLayoutsByTabId: {
      tab: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: leaf },
          second: { type: 'leaf', leafId: sibling }
        },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'old', [sibling]: 'sibling' }
      }
    },
    codexRestartNoticeByPtyId: {
      old: { previousAccountLabel: 'old', nextAccountLabel: 'new', incarnationId: 'inc-old' }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

it('blocks failed old-endpoint typing after remount while preserving replies and sibling input', () => {
  failCurrent()
  const old = input('old'),
    other = input('sibling', sibling)
  old.type('must not reach the old account\r')
  old.type('\x1b[1;1R')
  other.type('sibling command\r')
  expect(old.writes).toEqual([])
  expect(old.replies).toEqual(['\x1b[1;1R'])
  expect(other.writes).toEqual(['sibling command\r'])
})

it('leaves a same-ID successor and its input untouched and retires the obsolete failure at binding', () => {
  failCurrent()
  const successor = input('old', leaf, 'inc-successor')
  successor.type('successor command\r')
  useAppStore.getState().retireCodexRestartEndpoint('old', 'inc-successor')
  expect(successor.writes).toEqual(['successor command\r'])
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(0)
})

it('keeps rootless recovery failure guarded without borrowing a sibling binding', () => {
  useAppStore.setState({
    ptyIdsByTabId: { tab: ['old'] },
    terminalLayoutsByTabId: {
      tab: {
        root: null,
        activeLeafId: 'legacy',
        expandedLeafId: null,
        ptyIdsByLeafId: { legacy: 'old' }
      }
    }
  })
  useAppStore.getState().queuePaneAccountRestarts(['old'], 'codex')
  useAppStore.getState().clearCodexRestartNotice('old')
  const old = input('old')
  old.type('must remain blocked\r')
  expect(old.writes).toEqual([])
  expect(selectCodexStaleSessionCount(useAppStore.getState())).toBe(1)
})
