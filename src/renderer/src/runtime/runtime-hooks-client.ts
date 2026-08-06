import type { GlobalSettings, OrcaHooks } from '../../../shared/types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

function getHookInspectionTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): ReturnType<typeof getActiveRuntimeTarget> {
  if (runtimeOwnerEnvironmentId?.trim()) {
    return { kind: 'environment', environmentId: runtimeOwnerEnvironmentId.trim() }
  }
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind === 'runtime') {
    return { kind: 'environment', environmentId: parsedHost.environmentId }
  }
  return parsedHost ? { kind: 'local' } : getActiveRuntimeTarget(settings)
}

export type HookCheckResult = {
  status?: 'ok' | 'error'
  hasHooks: boolean
  hooks: OrcaHooks | null
  mayNeedUpdate: boolean
}

export type IssueCommandReadResult = {
  status?: 'ok' | 'error'
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

export async function checkRuntimeHooks(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): Promise<HookCheckResult> {
  const target = getHookInspectionTarget(settings, hostId, runtimeOwnerEnvironmentId)
  if (target.kind !== 'environment') {
    return window.api.hooks.check({ repoId, ...(hostId ? { hostId } : {}) })
  }
  return callRuntimeRpc<HookCheckResult>(
    target,
    'repo.hooksCheck',
    { repo: repoId, ...(hostId ? { executionHostId: hostId } : {}) },
    { timeoutMs: 15_000 }
  )
}

export async function inspectRuntimeSetupScriptImports(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): Promise<SetupScriptImportCandidate[]> {
  const target = getHookInspectionTarget(settings, hostId, runtimeOwnerEnvironmentId)
  if (target.kind !== 'environment') {
    return window.api.hooks.inspectSetupScriptImports({ repoId, ...(hostId ? { hostId } : {}) })
  }
  return callRuntimeRpc<SetupScriptImportCandidate[]>(
    target,
    'repo.setupScriptImports',
    { repo: repoId, ...(hostId ? { executionHostId: hostId } : {}) },
    { timeoutMs: 15_000 }
  )
}

export async function readRuntimeIssueCommand(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): Promise<IssueCommandReadResult> {
  const target = getHookInspectionTarget(settings, hostId, runtimeOwnerEnvironmentId)
  if (target.kind !== 'environment') {
    return window.api.hooks.readIssueCommand({ repoId, ...(hostId ? { hostId } : {}) })
  }
  return callRuntimeRpc<IssueCommandReadResult>(
    target,
    'repo.issueCommandRead',
    { repo: repoId, ...(hostId ? { executionHostId: hostId } : {}) },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeIssueCommand(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  content: string,
  hostId?: ExecutionHostId,
  runtimeOwnerEnvironmentId?: string | null
): Promise<void> {
  const target = getHookInspectionTarget(settings, hostId, runtimeOwnerEnvironmentId)
  if (target.kind !== 'environment') {
    await window.api.hooks.writeIssueCommand({ repoId, content, ...(hostId ? { hostId } : {}) })
    return
  }
  await callRuntimeRpc(
    target,
    'repo.issueCommandWrite',
    { repo: repoId, content, ...(hostId ? { executionHostId: hostId } : {}) },
    { timeoutMs: 15_000 }
  )
}
