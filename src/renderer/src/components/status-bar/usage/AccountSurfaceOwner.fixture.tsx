import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import PendingNativeChatCreation from '../../worktree-creation/PendingNativeChatCreation'
import { NativeChatComposerWorkspace } from '../../native-chat/composer/controls/NativeChatComposerWorkspace'
import { StatusBarSurface } from '../StatusBarSurface'

function provider(percent: number): ProviderRateLimits {
  return {
    provider: 'claude',
    status: 'ok',
    error: null,
    updatedAt: Date.now(),
    weekly: null,
    session: { usedPercent: percent, windowMinutes: 300, resetsAt: null, resetDescription: null }
  }
}
function fixture(
  hostId: ExecutionHostId | null,
  width = 800,
  hidden = false,
  full = false,
  split = false
) {
  const staleHost = hostId === 'local' ? 'runtime:m4' : 'local'
  const repo: Repo = {
    id: 'preview',
    path: '/preview',
    displayName: 'Preview',
    executionHostId: staleHost,
    addedAt: 1,
    badgeColor: ''
  }
  const source: Repo = { ...repo, id: 'source', executionHostId: hostId ?? 'local' }
  const worktree: Worktree = {
    id: 'preview::/preview',
    repoId: repo.id,
    hostId: staleHost,
    instanceId: 'preview',
    path: '/preview',
    displayName: 'Preview',
    branch: 'main',
    head: 'abc1234',
    isBare: false,
    isMainWorktree: true,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
  const pending: PendingWorktreeCreation = {
    creationId: 'creation',
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request: {
      repoId: hostId ? 'source' : 'missing',
      name: 'New chat',
      setupDecision: 'skip',
      agent: 'codex',
      agentLaunchRoute: 'structured-native-chat',
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null,
      suppressTerminalFocusOnCompletion: true,
      ...(hostId ? { executionHostId: hostId } : {})
    }
  }
  const local = createEmptyRateLimitState({ claude: provider(11) })
  const remote = createEmptyRateLimitState({ claude: provider(87) })
  return defineFixture({
    width,
    store: {
      settings: {
        ...getDefaultSettings('/home/fixture'),
        machineName: 'MacBook Pro',
        activeRuntimeEnvironmentId: 'm4'
      },
      repos: [repo, source],
      worktreesByRepo: { preview: [worktree] },
      activeWorktreeId: worktree.id,
      activeView: hidden ? 'settings' : 'terminal',
      activePendingCreationId: split ? null : 'creation',
      pendingWorktreeCreations: { creation: pending },
      runtimeEnvironments: [
        {
          id: 'm4',
          name: 'm4-air',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: 'fixture',
          preferredEndpointId: 'fixture',
          endpoints: []
        } satisfies PublicKnownRuntimeEnvironment
      ],
      runtimeEnvironmentCatalogHydrated: true,
      ...(split
        ? {
            activeGroupIdByWorktree: { [worktree.id]: 'right' },
            groupsByWorktree: {
              [worktree.id]: [
                {
                  id: 'right',
                  worktreeId: worktree.id,
                  tabOrder: ['right-tab'],
                  activeTabId: 'right-tab'
                }
              ]
            },
            unifiedTabsByWorktree: {
              [worktree.id]: [
                {
                  id: 'right-tab',
                  entityId: 'session',
                  contentType: 'agent-session' as const,
                  worktreeId: worktree.id,
                  groupId: 'right',
                  executionHostId: 'runtime:m4' as const,
                  label: 'Chat',
                  customLabel: null,
                  color: null,
                  sortOrder: 0,
                  createdAt: 1
                }
              ]
            }
          }
        : {}),
      rateLimits: local,
      statusBarVisible: true,
      statusBarItems: ['claude'],
      detectedAgentIds: ['claude'],
      ensureDetectedAgents: async () => ['claude'],
      fetchInactiveClaudeAccountUsage: async () => {}
    },
    setup: () => {
      window.api.runtimeEnvironments.subscribe = async (_args, handlers) => {
        handlers.onResponse?.({
          id: 'fixture',
          _meta: { runtimeId: 'fixture' },
          ok: true,
          result: {
            type: 'snapshot',
            snapshot: {
              claude: { accounts: [], activeAccountId: null },
              codex: { accounts: [], activeAccountId: null },
              rateLimits: remote
            }
          }
        })
        return { sendBinary: () => {}, unsubscribe: () => {} }
      }
    },
    render: () => (
      <div className="flex h-[540px] flex-col bg-background">
        <div className="relative min-h-0 flex-1">
          {full ? (
            <PendingNativeChatCreation creationId="creation" />
          ) : (
            <div className="absolute inset-x-0 bottom-3 p-3">
              <NativeChatComposerWorkspace
                terminalTabId={split ? 'right-tab' : 'pending-tab'}
                pendingCreationId={hidden || split ? undefined : 'creation'}
                structuredTransport={{
                  worktreeId: worktree.id,
                  runtimeEnvironmentId: split ? 'm4' : null
                }}
              />
            </div>
          )}
        </div>
        <StatusBarSurface floatingTerminalOpen={false} />
      </div>
    )
  })
}
export const localPending = fixture('local')
export const remotePending = fixture('runtime:m4')
export const remoteComposer = fixture('runtime:m4', 800, false, true)
export const hiddenPending = fixture('runtime:m4', 800, true)
export const unsupported = fixture('ssh:preview')
export const unresolved = fixture(null)
export const narrow = fixture('local', 360)

export const splitPane = fixture('runtime:m4', 800, false, false, true)
