import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { SetupScriptImportCandidate } from '../../../shared/setup-script-imports'
import { callRuntimeRpc } from './runtime-rpc-client'
import { ipcOrRuntimeTargetForHostId } from './runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

/** The repo's own host: a server's runtime, or this app (with `hostId`) for local and SSH repos. */
function getHookInspectionTarget(hostId: ExecutionHostId): RuntimeClientTarget {
  const target = ipcOrRuntimeTargetForHostId(hostId)
  if (!target) {
    throw new Error('The project host is unresolved.')
  }
  return target
}

export type HookCheckResult = {
  status?: 'ok' | 'error'
  hasHooks: boolean
  hooks: OrcaHooks | null
  mayNeedUpdate: boolean
  /** A background check refused because the repo's WSL distro is stopped. */
  unavailable?: 'wsl-distro-stopped'
}

export type IssueCommandReadResult = {
  status?: 'ok' | 'error'
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
}

/** `background`: a render-driven probe that must not boot a stopped WSL distro (E9); launches omit it. */
export async function checkRuntimeHooks(
  hostId: ExecutionHostId,
  repoId: string,
  options: { background?: boolean } = {}
): Promise<HookCheckResult> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.check({
      repoId,
      hostId,
      ...(options.background ? { background: true } : {})
    })
  }
  return callRuntimeRpc<HookCheckResult>(
    target,
    'repo.hooksCheck',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function inspectRuntimeSetupScriptImports(
  hostId: ExecutionHostId,
  repoId: string
): Promise<SetupScriptImportCandidate[]> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.inspectSetupScriptImports({ repoId, hostId })
  }
  return callRuntimeRpc<SetupScriptImportCandidate[]>(
    target,
    'repo.setupScriptImports',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function readRuntimeIssueCommand(
  hostId: ExecutionHostId,
  repoId: string
): Promise<IssueCommandReadResult> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.readIssueCommand({ repoId, hostId })
  }
  return callRuntimeRpc<IssueCommandReadResult>(
    target,
    'repo.issueCommandRead',
    { repo: repoId },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeIssueCommand(
  hostId: ExecutionHostId,
  repoId: string,
  content: string
): Promise<void> {
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    await window.api.hooks.writeIssueCommand({ repoId, content, hostId })
    return
  }
  await callRuntimeRpc(
    target,
    'repo.issueCommandWrite',
    { repo: repoId, content },
    { timeoutMs: 15_000 }
  )
}
