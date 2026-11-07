import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { TERMINAL_ARTIFACT_CHUNK_RUNTIME_CAPABILITY } from '../../../../../shared/files-runtime-capabilities'
import {
  SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE,
  TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES,
  TERMINAL_PATH_ABSOLUTE_FILES_RUNTIME_CAPABILITY,
  TERMINAL_PATH_IN_PLACE_FILES_RUNTIME_CAPABILITY,
  type RuntimeTerminalPathResolution
} from '../../../../../shared/runtime-file-contracts'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { toRuntimeWorktreeSelector } from '../../runtime-worktree-selector'
import { captureRuntimeEnvironmentRequestRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { isRenewableTerminalFileGrantRefusal } from '../../../../../shared/terminal-file-grant-refusal'

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
  // Why IPC: a media preview's host calls run in main, which relays the host's refusal.
  return isRenewableTerminalFileGrantRefusal(
    error instanceof RuntimeRpcCallError ? error.message : readIpcErrorMessage(error)
  )
}

export type RenewedTerminalArtifactGrant = {
  grantId: string
  readOnly: boolean
  /** The file's size when granted; older hosts omit it. */
  byteLength?: number
  /** Set when the grant can't serve the file as text. */
  binary?: true
}

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
  const granted = await acquireTerminalArtifactGrant(args)
  // Why: restoration and renewal must not follow a path redirected since the first grant.
  if (granted && granted.absolutePath !== args.absolutePath) {
    throw new Error(`The host no longer grants ${args.absolutePath}`)
  }
  return granted
    ? {
        grantId: granted.grantId,
        readOnly: granted.readOnly,
        ...(granted.byteLength === undefined ? {} : { byteLength: granted.byteLength }),
        ...(granted.binary ? { binary: true as const } : {})
      }
    : null
}

/** First acquisition adopts the canonical path the host bound to its grant. */
export async function acquireTerminalArtifactGrant(
  args: TerminalArtifactGrantTarget
): Promise<(RenewedTerminalArtifactGrant & { absolutePath: string }) | null> {
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
  if (openTarget?.kind === 'absolute-file') {
    return {
      absolutePath: openTarget.absolutePath,
      grantId: openTarget.grantId,
      readOnly: openTarget.readOnly === true,
      ...(openTarget.byteLength === undefined ? {} : { byteLength: openTarget.byteLength }),
      ...(openTarget.binary ? { binary: true as const } : {})
    }
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
  // Why: an existing path without an absolute-file grant cannot authorize a read or save.
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

// Why: hosts cap a grant write at their mobile read budget; refuse before sending the bytes.
export const TERMINAL_ARTIFACT_WRITE_MAX_BYTES = 512 * 1024

/** Whether this host reports what a grant can serve, so a file another workspace holds may open in place; rejects when unanswered. */
export function hostOpensGrantedFilesInPlace(environmentId: string): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    environmentId,
    TERMINAL_PATH_IN_PLACE_FILES_RUNTIME_CAPABILITY,
    15_000
  )
}

/**
 * Whether a grant can stand in for the workspace holding its file: it saves only small text in one
 * request, while the holder stages large saves and writes bytes editors' edits.
 */
export function grantServesInPlace(grant: { byteLength?: number; binary?: true }): boolean {
  return (
    grant.byteLength !== undefined &&
    grant.byteLength <= TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES &&
    !grant.binary
  )
}

/** The host's refusal to grant outside its SSH workspaces; any other failure may be transient. */
export function isSshWorkspaceGrantRefusal(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    error.code === 'runtime_error' &&
    error.message === SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE
  )
}

/** Older hosts read a granted file only whole and as text, so it opens in Orca instead of downloading. */
export async function hostStreamsGrantedFiles(environmentId: string): Promise<boolean> {
  try {
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_ARTIFACT_CHUNK_RUNTIME_CAPABILITY,
      15_000
    )
  } catch {
    return false
  }
}
