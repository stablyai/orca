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
  /** A background check refused because the repo's WSL distro is stopped or didn't answer. */
  unavailable?: 'wsl-distro-stopped' | 'wsl-distro-unverifiable'
}

export type IssueCommandReadResult = {
  status?: 'ok' | 'error'
  localContent: string | null
  sharedContent: string | null
  effectiveContent: string | null
  localFilePath: string
  source: 'local' | 'shared' | 'none'
  /** A stopped WSL distro refused the read (E9); the content is unknown, not empty. */
  refusedWslDistro?: string
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
    { repo: repoId, ...(options.background ? { background: true } : {}) },
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

/** `wakeWslDistro`: a launch, a user act that may start the repo's stopped WSL distro (E9). */
export async function readRuntimeIssueCommand(
  hostId: ExecutionHostId,
  repoId: string,
  options: { wakeWslDistro?: boolean } = {}
): Promise<IssueCommandReadResult> {
  const wake = options.wakeWslDistro ? { wakeWslDistro: true } : {}
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    return window.api.hooks.readIssueCommand({ repoId, hostId, ...wake })
  }
  return callRuntimeRpc<IssueCommandReadResult>(
    target,
    'repo.issueCommandRead',
    { repo: repoId, ...wake },
    { timeoutMs: 15_000 }
  )
}

/** `wakeWslDistro`: the user saving their own edit, which may start the repo's stopped WSL distro. */
export async function writeRuntimeIssueCommand(
  hostId: ExecutionHostId,
  repoId: string,
  content: string,
  options: { wakeWslDistro?: boolean } = {}
): Promise<void> {
  const wake = options.wakeWslDistro ? { wakeWslDistro: true } : {}
  const target = getHookInspectionTarget(hostId)
  if (target.kind !== 'environment') {
    await window.api.hooks.writeIssueCommand({ repoId, content, hostId, ...wake })
    return
  }
  await callRuntimeRpc(
    target,
    'repo.issueCommandWrite',
    { repo: repoId, content, ...wake },
    { timeoutMs: 15_000 }
  )
}
