import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import type { AppState } from '../types'
import { callRuntimeRpc, ensureRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
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
  const fallbackWorktreeRoute = retirementPlan.worktreeId
    ? resolveTerminalWorktreeRoute(state, retirementPlan.worktreeId)
    : { runtimeEnvironmentId: null }
  const retirementTasks: Promise<unknown>[] = localPtyTeardownOwnedExternally
    ? []
    : retirementPlan.localOrSshPtyIds.map(async (ptyId) => window.api.pty.kill(ptyId))
  const localOrSshTaskCount = retirementTasks.length
  if (!remoteCloseOwnedByHost) {
    for (const terminal of retirementPlan.runtimeTerminals) {
      if (!terminal.environmentId && !fallbackWorktreeRoute) {
        continue
      }
      const environmentId = terminal.environmentId ?? fallbackWorktreeRoute?.runtimeEnvironmentId
      retirementTasks.push(
        retireRuntimeTerminal(environmentId, terminal.handle, canRetireRuntimeTerminal)
      )
    }
  }
  if (retirementPlan.unroutablePtyIds.length > 0) {
    // Log the worktree shape, never its id, because worktree ids embed absolute paths.
    console.warn('[terminal-retirement] skipped PTYs with no resolvable owner', {
      tabId,
      worktreeKind: classifyTerminalRetirementWorktree(retirementPlan.worktreeId),
      count: retirementPlan.unroutablePtyIds.length
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
