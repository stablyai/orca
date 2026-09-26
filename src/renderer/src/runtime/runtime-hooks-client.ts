import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import type { RepoCommandKind } from '../../../shared/repo-command-kind'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

function getHookInspectionTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  hostId?: ExecutionHostId
): ReturnType<typeof getActiveRuntimeTarget> {
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
  hostId?: ExecutionHostId
): Promise<HookCheckResult> {
  const target = getHookInspectionTarget(settings, hostId)
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
  repoId: string,
  hostId?: ExecutionHostId
): Promise<SetupScriptImportCandidate[]> {
  const target = getHookInspectionTarget(settings, hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.inspectSetupScriptImports({ repoId, ...(hostId ? { hostId } : {}) })
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
  repoId: string,
  hostId?: ExecutionHostId,
  kind: RepoCommandKind = 'issue'
): Promise<IssueCommandReadResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    // Why: omit `kind` for issues so existing callers and older preload builds see the old args.
    return window.api.hooks.readIssueCommand({
      repoId,
      ...(hostId ? { hostId } : {}),
      ...(kind === 'issue' ? {} : { kind })
    })
  }
  // Why: a pre-review-template host has no such method and rejects; callers already handle a
  // failed read. See docs/reference/remote-wire-compatibility.md.
  return callRuntimeRpc<IssueCommandReadResult>(
    target,
    kind === 'review' ? 'repo.reviewCommandRead' : 'repo.issueCommandRead',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeIssueCommand(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  content: string,
  hostId?: ExecutionHostId,
  kind: RepoCommandKind = 'issue'
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    await window.api.hooks.writeIssueCommand({
      repoId,
      content,
      ...(hostId ? { hostId } : {}),
      ...(kind === 'issue' ? {} : { kind })
    })
    return
  }
  await callRuntimeRpc(
    target,
    kind === 'review' ? 'repo.reviewCommandWrite' : 'repo.issueCommandWrite',
    { repo: repoId, content },
    { timeoutMs: 15_000 }
  )
}
