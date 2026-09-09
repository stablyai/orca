/**
 * Where an Office document renders, and on whose machine.
 *
 * Pure: no store subscription, no IPC. The pane, the routing plan and the tests all ask the same
 * two questions here, so a document cannot be routed one way by the file tree and another by a
 * terminal link.
 */
import {
  isIdentifiedUnrenderableOffice,
  isOfficeRenderable,
  officeDocKind,
  officeFileExtension,
  type OfficeDocKind
} from '../../../shared/office-file-extensions'
import type { OfficeHostOwner } from '../../../shared/office-host-owner'
import { useShallow } from 'zustand/react/shallow'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

/**
 * The host that owns the document, or `null` when ownership could not be resolved.
 *
 * `null` is never "run it here". Per docs/reference/ssh-execution-boundary.md an unresolved owner
 * cannot pick a channel, and rendering locally would hand a remote path to this machine's
 * `officecli` and this machine's fonts.
 */
export function resolveOfficeHostOwner(
  state: AppState,
  worktreeId: string,
  filePath: string
): OfficeHostOwner | null {
  const connectionId = getConnectionIdForFileFromState(state, worktreeId, filePath)
  if (connectionId === undefined) {
    return null
  }
  if (connectionId !== null) {
    return { kind: 'ssh', connectionId }
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return environmentId ? { kind: 'runtime', environmentId } : { kind: 'local' }
}

/**
 * The owning host, subscribed with shallow equality.
 *
 * Why a dedicated hook and not a bare selector: `resolveOfficeHostOwner` builds a fresh object on
 * every call, and Zustand compares selector results with `Object.is`. A bare selector therefore
 * reports a change on every store write, re-renders the pane, and — because the object is also an
 * effect dependency — re-runs the render and probe effects, which write state, which re-renders.
 * That loop is React #185, and it took down the whole workbench, not just the preview.
 */
export function useOfficeHostOwner(worktreeId: string, filePath: string): OfficeHostOwner | null {
  return useAppStore(
    useShallow((state: AppState) => resolveOfficeHostOwner(state, worktreeId, filePath))
  )
}

export type OfficePreviewRouting =
  | { status: 'renderable'; kind: OfficeDocKind }
  /** A first-class outcome, not an error: we know the format and we do not render it. */
  | { status: 'unrenderable'; extension: string }
  | { status: 'not-office' }

export function resolveOfficePreviewRouting(filePath: string): OfficePreviewRouting {
  const kind = officeDocKind(filePath)
  if (kind && isOfficeRenderable(filePath)) {
    return { status: 'renderable', kind }
  }
  return isIdentifiedUnrenderableOffice(filePath)
    ? { status: 'unrenderable', extension: officeFileExtension(filePath) }
    : { status: 'not-office' }
}
