import { useAppStore } from '@/store'
import { codexAccountRestartToken } from '@/store/terminals/codex-account-restart-continuation'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import { formatAccountRestartFailure } from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
type PtyConnectOptions = Parameters<PtyTransport['connect']>[0]

export const leaf = '00000000-0000-4000-8000-000000000001'
export const sibling = '00000000-0000-4000-8000-000000000002'
export const key = `tab:${leaf}`
export const notice = { previousAccountLabel: 'old', nextAccountLabel: 'new' }
export function seed() {
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
    codexRestartNoticeByPtyId: { old: notice },
    paneAccountRestarts: {}
  })
}
export function receipt(
  request: CodexAccountRestart,
  stop: 'not-started' | 'confirmed-retired' | 'unknown',
  kind: 'original' | 'empty'
) {
  return new Error(
    formatAccountRestartFailure('launch refused', {
      v: 1,
      requestId: request.requestId,
      attemptId: request.attemptId,
      stop,
      outcome: 'terminal',
      current: {
        kind,
        bindingGeneration: kind === 'empty' ? 1 : 0,
        ...(kind === 'original' ? { incarnationId: 'inc-old' } : {})
      }
    })
  )
}
export function snapshot(
  owner: { ptyId: string; incarnationId: string } | null,
  generation = 0,
  tabCreatedAt = 1
) {
  return {
    ok: true,
    id: 'resolve',
    result: {
      terminal: {
        handle: 'handle-old',
        accountRestart: { hostEpoch: 'host', tabCreatedAt, bindingGeneration: generation, owner }
      }
    }
  }
}

export function mountedSpawnSession(
  request: CodexAccountRestart,
  scrollback: Map<string, string>,
  connect: (options: PtyConnectOptions) => Promise<unknown>,
  incarnationId?: string
) {
  const noop = () => {}
  return {
    deps: {
      tabId: 'tab',
      worktreeId: 'wt',
      accountRestartToken: codexAccountRestartToken(request),
      accountRestart: request.condition,
      isVisibleRef: { current: false },
      invalidateRetainedInlineScrollback: (leafId: string) => scrollback.delete(leafId)
    },
    pane: { id: 1, leafId: leaf },
    paneStartup: { command: 'codex resume conversation-1' },
    remotePtyIncarnationId: incarnationId,
    disposed: false,
    tabGeneration: 0,
    transportStreamGeneration: 1,
    authoritativeReattachGeneration: 0,
    pendingSpawnKey: key,
    cacheKey: key,
    userRestart: false,
    runtimeEnvironmentId: null,
    transport: { connect, getPtyId: (): string | null => null },
    clearPaneMode2031State: noop,
    clearHiddenOutputRestoreState: noop,
    resetFreshSpawnFollowOutput: noop,
    groundInputModesForNewProcess: noop,
    prepareFreshShellViewportForSpawn: noop,
    shouldDeclareHiddenAtSpawn: () => true,
    captureTransportOutputCallbacks: (onError: (message: string) => void) => ({
      generation: 1,
      callbacks: { onError }
    }),
    reportError: noop,
    finishReattachLiveDataDeferral: noop,
    noteBoundProcessIncarnation: noop,
    settlePaneAttachAttempt: noop,
    startFreshSpawn: (_startup?: { command: string }): Promise<string | null> =>
      Promise.resolve(null)
  }
}
