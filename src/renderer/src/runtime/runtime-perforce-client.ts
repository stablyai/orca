import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  PerforceOperationName,
  PerforceOperationParams,
  PerforceOperationResult
} from '../../../shared/perforce/perforce-operations'
import {
  normalizePerforceSettings,
  perforceRequestTimeoutMs,
  perforceSettingsForRemoteHost,
  type PerforceSettings
} from '../../../shared/perforce/perforce-settings'
import {
  PERFORCE_COPY_REQUEST_TIMEOUT_MS,
  type PerforceCopyOperationName,
  type PerforceCopyOperationParams,
  type PerforceCopyOperationResult
} from '../../../shared/perforce/workspace-copy/workspace-copy-operations'
import type { WorkspaceCopyIpcResult } from '../../../shared/perforce/workspace-copy/workspace-copy-types'
import {
  PERFORCE_RUNTIME_CAPABILITY,
  PERFORCE_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/perforce/perforce-runtime-capability'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { RuntimeClientTarget } from './runtime-client-target'
import {
  getRuntimeGitScope,
  resolveLocalWorktreePath,
  type RuntimeGitContext,
  type RuntimeGitSettings
} from './runtime-git-client-context'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import type { ExecutionHostId } from '../../../shared/execution-host'

export type PerforceClientSettings = RuntimeGitSettings & Partial<Pick<GlobalSettings, 'perforce'>>

/**
 * The workspace a Perforce request runs in, routed like Git: through this desktop (a local folder
 * or an SSH host's) or to the Orca server that owns it. `settings` are the owner-routed settings.
 */
export type PerforceWorkspaceTarget = RuntimeGitContext & {
  settings: PerforceClientSettings | null | undefined
}

/** Identifies a workspace across hosts, for caches keyed by workspace. */
export function perforceWorkspaceKey(target: PerforceWorkspaceTarget): string {
  return `${getRuntimeGitScope(target.settings, target.connectionId) ?? ''}|${target.worktreePath}`
}

/** What a remote host receives: this user's Settings > Perforce minus the machine-specific ones. */
export function remotePerforceSettings(
  settings: Pick<PerforceClientSettings, 'perforce'> | null | undefined
): PerforceSettings {
  return perforceSettingsForRemoteHost(normalizePerforceSettings(settings?.perforce))
}

/** Refuses before calling a host whose Orca build has no perforce.* methods. */
export async function assertPerforceRuntime(target: RuntimeClientTarget): Promise<void> {
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      PERFORCE_RUNTIME_CAPABILITY,
      PERFORCE_UPDATE_REQUIRED_MESSAGE
    )
  }
}

/** This desktop's Perforce IPC; a paired browser has none, so a workspace it cannot route fails here. */
function desktopPerforceApi(): Window['api']['perforce'] {
  if (isPairedWebClientWindow()) {
    throw new Error(
      'Orca could not tell which server owns this workspace. Reconnect and try again.'
    )
  }
  return window.api.perforce
}

export async function runPerforceOperation<K extends PerforceOperationName>(
  target: PerforceWorkspaceTarget,
  operation: K,
  params: PerforceOperationParams[K]
): Promise<PerforceOperationResult<K>> {
  const runtimeTarget = getActiveRuntimeTarget(target.settings)
  if (runtimeTarget.kind === 'local' || !target.worktreeId) {
    return desktopPerforceApi().run(operation, {
      ...params,
      worktreePath: resolveLocalWorktreePath(target),
      ...(target.connectionId ? { connectionId: target.connectionId } : {})
    })
  }
  await assertPerforceRuntime(runtimeTarget)
  const settings = remotePerforceSettings(target.settings)
  return callRuntimeRpc<PerforceOperationResult<K>>(
    runtimeTarget,
    `perforce.${operation}`,
    { ...params, worktree: toRuntimeWorktreeSelector(target.worktreeId), settings },
    { timeoutMs: perforceRequestTimeoutMs(settings, operation) }
  )
}

/** `runPerforceOperation` bound to one workspace. */
export function perforceOperationsFor(target: PerforceWorkspaceTarget) {
  return <K extends PerforceOperationName>(
    operation: K,
    params: PerforceOperationParams[K]
  ): Promise<PerforceOperationResult<K>> => runPerforceOperation(target, operation, params)
}

/** A Perforce folder project, routed to the host that owns it; `settings` are its owner-routed settings. */
export type PerforceProjectTarget = {
  settings: PerforceClientSettings | null | undefined
  repoId: string
  /** The project's execution host, for a desktop that has the same project id on several hosts. */
  hostId?: ExecutionHostId
}

/** One copy operation of a Perforce folder project; failures come back as `{ ok: false }` on every route. */
export async function runPerforceCopyOperation<K extends PerforceCopyOperationName>(
  target: PerforceProjectTarget,
  operation: K,
  params: PerforceCopyOperationParams<K>
): Promise<WorkspaceCopyIpcResult<PerforceCopyOperationResult<K>>> {
  const runtimeTarget = getActiveRuntimeTarget(target.settings)
  try {
    if (runtimeTarget.kind === 'local') {
      return await desktopPerforceApi().runCopy(operation, {
        ...params,
        repoId: target.repoId,
        ...(target.hostId ? { hostId: target.hostId } : {})
      })
    }
    await assertPerforceRuntime(runtimeTarget)
    const value = await callRuntimeRpc<PerforceCopyOperationResult<K>>(
      runtimeTarget,
      `perforce.${operation}`,
      { ...params, repo: `id:${target.repoId}`, settings: remotePerforceSettings(target.settings) },
      { timeoutMs: PERFORCE_COPY_REQUEST_TIMEOUT_MS }
    )
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export type PerforceDescriptionResult =
  | { success: true; message: string }
  | { success: false; error: string }

/** Drafts a changelist description where the workspace lives, with this user's agent choices. */
export async function generatePerforceDescription(
  target: PerforceWorkspaceTarget,
  request: { changelist: 'default' | 'new' | number; filePaths: string[] }
): Promise<PerforceDescriptionResult> {
  const runtimeTarget = getActiveRuntimeTarget(target.settings)
  if (runtimeTarget.kind === 'local' || !target.worktreeId) {
    return desktopPerforceApi().generateDescription({
      ...request,
      worktreePath: resolveLocalWorktreePath(target),
      ...(target.connectionId ? { connectionId: target.connectionId } : {})
    })
  }
  await assertPerforceRuntime(runtimeTarget)
  const { agentCmdOverrides, defaultTuiAgent } = target.settings ?? {}
  return callRuntimeRpc<PerforceDescriptionResult>(
    runtimeTarget,
    'perforce.generateDescription',
    {
      ...request,
      worktree: toRuntimeWorktreeSelector(target.worktreeId),
      settings: remotePerforceSettings(target.settings),
      ...(agentCmdOverrides ? { agentCmdOverrides } : {}),
      // Why: 'blank' (no default agent) is not an agent; leaving it out lets the host choose.
      ...(defaultTuiAgent === null || isTuiAgent(defaultTuiAgent) ? { defaultTuiAgent } : {})
    },
    { timeoutMs: 75_000 }
  )
}
