import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import type { AppState } from '../types'
import { callRuntimeRpc, ensureRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import {
  resolveTerminalPtyOwner,
  resolveTerminalWorktreeRoute
} from '@/lib/terminal-worktree-route'
import {
  classifyTerminalRetirementWorktree,
  type TerminalTabRetirementPlan
} from '../slices/terminal-tab-retirement'

export function startTerminalTabProviderRetirement({
  localPtyTeardownOwnedExternally,
  remoteCloseOwnedByHost,
  retirementPlan,
  state,
  tabId,
  canRetireRuntimeTerminal
}: {
  localPtyTeardownOwnedExternally: boolean
  remoteCloseOwnedByHost: boolean
  retirementPlan: TerminalTabRetirementPlan
  state: AppState
  tabId: string
  canRetireRuntimeTerminal?: () => boolean
}): void {
  const { worktreeId } = retirementPlan
  // Why: an unscoped `remote:` id of an unattributable twin must not be closed on this app.
  const fallbackWorktreeRoute = !worktreeId
    ? { runtimeEnvironmentId: null }
    : resolveTerminalPtyOwner(state, worktreeId, 'spawn').kind === 'ambiguous'
      ? null
      : resolveTerminalWorktreeRoute(state, worktreeId)
  const retirementTasks: Promise<unknown>[] = localPtyTeardownOwnedExternally
    ? []
    : retirementPlan.localOrSshPtyIds.map(async (ptyId) => window.api.pty.kill(ptyId))
  const localOrSshTaskCount = retirementTasks.length
  let unroutableRuntimeTerminalCount = 0
  if (!remoteCloseOwnedByHost) {
    for (const terminal of retirementPlan.runtimeTerminals) {
      if (!terminal.environmentId && !fallbackWorktreeRoute) {
        unroutableRuntimeTerminalCount += 1
        continue
      }
      const environmentId = terminal.environmentId ?? fallbackWorktreeRoute?.runtimeEnvironmentId
      retirementTasks.push(
        retireRuntimeTerminal(environmentId, terminal.handle, canRetireRuntimeTerminal)
      )
    }
  }
  const unroutableCount = retirementPlan.unroutablePtyIds.length + unroutableRuntimeTerminalCount
  if (unroutableCount > 0) {
    // Log the worktree shape, never its id, because worktree ids embed absolute paths.
    console.warn('[terminal-retirement] skipped PTYs with no resolvable owner', {
      tabId,
      worktreeKind: classifyTerminalRetirementWorktree(retirementPlan.worktreeId),
      count: unroutableCount
    })
  }
  // Close remains synchronous; provider failures cannot block ownership revocation.
  void Promise.allSettled(retirementTasks).then((results) => {
    const localOrSshFailures = results
      .slice(0, localOrSshTaskCount)
      .filter((result) => result.status === 'rejected').length
    const runtimeFailures = results
      .slice(localOrSshTaskCount)
      .filter((result) => result.status === 'rejected').length
    if (localOrSshFailures > 0 || runtimeFailures > 0) {
      console.warn('[terminal-retirement] provider teardown failed', {
        tabId,
        localOrSshFailures,
        runtimeFailures
      })
    }
  })
}

async function retireRuntimeTerminal(
  environmentId: string | null | undefined,
  handle: string,
  canRetire?: () => boolean
): Promise<unknown> {
  const target = environmentId
    ? { kind: 'environment' as const, environmentId }
    : { kind: 'local' as const }
  if (!canRetire) {
    return callRuntimeRpc(target, 'terminal.close', { terminal: handle })
  }
  const revision = environmentId
    ? captureRuntimeEnvironmentRequestRevision(environmentId)
    : undefined
  if (environmentId) {
    await ensureRuntimeEnvironmentCompatible(environmentId, {
      expectedEnvironmentPairingRevision: revision
    })
  }
  if (
    (environmentId && getRuntimeEnvironmentRevision(environmentId) !== revision) ||
    !canRetire()
  ) {
    return
  }
  // Compatibility was checked above; recheck pane ownership at the actual dispatch boundary.
  return callRuntimeRpc(
    target,
    'terminal.close',
    { terminal: handle },
    {
      skipCompatibilityCheck: true,
      expectedEnvironmentPairingRevision: revision
    }
  )
}

export function startTerminalHostAliasRetirement(
  aliasRow: TerminalTab,
  get: () => AppState,
  opts: Parameters<AppState['closeTab']>[1]
): void {
  const alias = aliasRow.hostTerminalAlias
  if (!alias) {
    return
  }
  const host = parseExecutionHostId(alias.executionHostId)
  const close =
    host?.kind !== 'runtime'
      ? Promise.resolve('failed' as const)
      : aliasRow.hostTerminalAliasGone
        ? Promise.resolve('unknown-tab' as const)
        : import('@/runtime/web-runtime-session-tab-lifecycle').then(
            ({ closeWebRuntimeSessionTab }) =>
              closeWebRuntimeSessionTab({
                worktreeId: alias.worktreeId,
                tabId: alias.tabId,
                environmentId: host.environmentId,
                reason: 'user',
                ...(opts?.force ? { force: true } : {})
              })
          )
  void close
    .then((outcome) => {
      const current = get().tabsByWorktree[aliasRow.worktreeId]?.find(
        (row) => row.id === aliasRow.id
      )?.hostTerminalAlias
      if (
        outcome !== 'failed' &&
        current?.executionHostId === alias.executionHostId &&
        current.worktreeId === alias.worktreeId &&
        current.tabId === alias.tabId
      ) {
        get().closeTab(aliasRow.id, {
          ...opts,
          captureRecentlyClosed: false,
          remoteCloseOwnedByHost: true,
          localPtyTeardownOwnedExternally: true,
          hostAliasCloseConfirmed: true
        })
      }
    })
    .catch((error) => console.warn('HOST alias close failed', error))
}
