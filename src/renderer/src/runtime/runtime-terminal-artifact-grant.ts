import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  TERMINAL_PATH_ABSOLUTE_FILES_RUNTIME_CAPABILITY,
  type RuntimeTerminalPathResolution
} from '../../../shared/runtime-file-contracts'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'

// Why: the host refuses a grant whose file changed, expired, or belongs to an earlier connection.
const RENEWABLE_GRANT_ERRORS = new Set([
  'terminal_file_grant_stale',
  'terminal_file_grant_expired',
  'terminal_file_grant_mismatch'
])

export type TerminalArtifactGrantTarget = {
  target: RuntimeClientTarget & { kind: 'environment' }
  worktreeId: string
  absolutePath: string
  /** Pinned before the first await so a same-id re-pair cannot retarget a later step. */
  expectedEnvironmentPairingRevision?: number
}

export function pinTerminalArtifactGrantTarget<T extends TerminalArtifactGrantTarget>(args: T): T {
  return {
    ...args,
    expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(
      args.target.environmentId,
      args.expectedEnvironmentPairingRevision
    )
  }
}

export function isRenewableGrantError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && RENEWABLE_GRANT_ERRORS.has(error.message)
}

export type RenewedTerminalArtifactGrant = { grantId: string; readOnly: boolean }

/** A grant for a restored tab's host file, which never kept its grant; rejects when the host lacks it. */
export async function renewRestoredHostFileGrant(
  args: TerminalArtifactGrantTarget
): Promise<string> {
  const renewed = await renewTerminalArtifactGrant(args)
  if (!renewed) {
    throw new Error(`File not found on its host: ${args.absolutePath}`)
  }
  return renewed.grantId
}

/** A fresh grant for the same host path, or null when the host no longer has the file. */
export async function renewTerminalArtifactGrant(
  args: TerminalArtifactGrantTarget
): Promise<RenewedTerminalArtifactGrant | null> {
  const resolved = await callRuntimeRpc<RuntimeTerminalPathResolution>(
    args.target,
    'files.resolveTerminalPath',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      // Why: no crossWorkspace, so a path another workspace holds still renews as the same grant.
      pathText: args.absolutePath
    },
    {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
    }
  )
  const openTarget = resolved.openTarget
  if (openTarget?.kind === 'absolute-file' && openTarget.absolutePath === args.absolutePath) {
    return { grantId: openTarget.grantId, readOnly: openTarget.readOnly === true }
  }
  if (!resolved.exists) {
    // Why: older hosts re-grant only for the terminal that printed the path, so their "absent" is no proof.
    if (
      !(await runtimeEnvironmentSupportsCapability(
        args.target.environmentId,
        TERMINAL_PATH_ABSOLUTE_FILES_RUNTIME_CAPABILITY,
        15_000
      ))
    ) {
      throw new Error('Update Orca on this host to keep editing files outside its workspaces.')
    }
    return null
  }
  // Why: never redirect a read or save elsewhere; the host must grant this exact path.
  throw new Error(`The host no longer grants ${args.absolutePath}`)
}

/** Older hosts' grants go stale on any host-side change and can't be renewed, so their tabs stay read-only. */
export async function hostSavesGrantedFiles(environmentId: string): Promise<boolean> {
  try {
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_PATH_ABSOLUTE_FILES_RUNTIME_CAPABILITY,
      15_000
    )
  } catch {
    // Why: an unanswered probe must not block opening; the tab just opens read-only.
    return false
  }
}
