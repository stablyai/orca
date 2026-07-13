import type { GlobalSettings, OrcaHooks } from '../../../shared/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

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
  hostId?: ExecutionHostId
): Promise<HookCheckResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.hooks.check({ repoId, ...(hostId ? { hostId } : {}) })
  }
  return callRuntimeRpc<HookCheckResult>(
    target,
    'repo.hooksCheck',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function inspectRuntimeSetupScriptImports(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string
): Promise<SetupScriptImportCandidate[]> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.hooks.inspectSetupScriptImports({ repoId })
  }
  return callRuntimeRpc<SetupScriptImportCandidate[]>(
    target,
    'repo.setupScriptImports',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function readRuntimeIssueCommand(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string
): Promise<IssueCommandReadResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.hooks.readIssueCommand({ repoId })
  }
  return callRuntimeRpc<IssueCommandReadResult>(
    target,
    'repo.issueCommandRead',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeIssueCommand(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  content: string
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    await window.api.hooks.writeIssueCommand({ repoId, content })
    return
  }
  await callRuntimeRpc(
    target,
    'repo.issueCommandWrite',
    { repo: repoId, content },
    { timeoutMs: 15_000 }
  )
}
