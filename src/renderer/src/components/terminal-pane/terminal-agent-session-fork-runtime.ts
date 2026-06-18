import { toast } from 'sonner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type {
  RuntimeAgentSessionForkCreateResult,
  RuntimeAgentSessionForkPreflightResult
} from '../../../../shared/runtime-types'
import type {
  PreparedAgentSessionFork,
  PreflightAgentSessionForkOptions,
  StartAgentSessionForkOptions
} from './terminal-agent-session-fork'

export async function preflightAgentSessionFork(
  fork: PreparedAgentSessionFork,
  options: PreflightAgentSessionForkOptions = {}
): Promise<RuntimeAgentSessionForkPreflightResult | null> {
  if (!fork.terminalHandle) {
    return null
  }
  const state = useAppStore.getState()
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(state, fork.worktreeId)
  )
  const message = options.message?.trim()
  return callRuntimeRpc<RuntimeAgentSessionForkPreflightResult>(
    runtimeTarget,
    'fork.preflight',
    {
      terminal: fork.terminalHandle,
      ...(message ? { message } : {}),
      noCopyFiles: options.noCopyFiles === true
    },
    { timeoutMs: 30_000 }
  )
}

export async function startRuntimeAgentSessionFork(
  fork: PreparedAgentSessionFork,
  options: StartAgentSessionForkOptions
): Promise<boolean> {
  if (!fork.terminalHandle) {
    return false
  }
  const state = useAppStore.getState()
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(state, fork.worktreeId)
  )
  const message = options.message?.trim()
  const result = await callRuntimeRpc<RuntimeAgentSessionForkCreateResult>(
    runtimeTarget,
    'fork.create',
    {
      terminal: fork.terminalHandle,
      activate: options.activate !== false,
      noCopyFiles: options.noCopyFiles === true,
      ...(message ? { message } : {}),
      ...(options.name?.trim() ? { name: options.name.trim() } : {})
    },
    { timeoutMs: 10 * 60_000 }
  )
  await useAppStore
    .getState()
    .fetchWorktrees(result.worktree.repoId)
    .catch(() => undefined)
  if (options.activate !== false) {
    activateAndRevealWorktree(result.fork.targetWorktreeId, { sidebarRevealBehavior: 'auto' })
  }
  toast.success(
    result.fork.contextDelivery.mode === 'native-provider'
      ? translate(
          'auto.components.terminal.pane.terminal.agent.session.fork.537d126b34',
          'Native session fork opened'
        )
      : result.fork.workspaceMode === 'same-workspace'
        ? translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.5e69cf039a',
            'Session fork opened in this workspace'
          )
        : translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.88e34d00eb',
            'Session fork opened in a child workspace'
          )
  )
  return true
}
