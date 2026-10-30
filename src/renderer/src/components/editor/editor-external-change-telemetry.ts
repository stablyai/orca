// Share path-free conflict enums across marking and banner actions so false-banner rates remain comparable by transport.
import { track } from '@/lib/telemetry'
import { getConnectionIdForFile } from '@/lib/connection-context'
import type { OpenFile } from '@/store/slices/editor'

type ConflictSurface = 'edit' | 'unstaged-diff'
type ConflictTransport = 'local' | 'ssh' | 'runtime'

export type ExternalChangeConflictAction =
  | 'reload'
  | 'keep'
  | 'compare'
  | 'undo_reload'
  | 'save_overwrite'

function conflictSurface(file: Pick<OpenFile, 'mode'>): ConflictSurface {
  return file.mode === 'edit' ? 'edit' : 'unstaged-diff'
}

export function conflictTransport(
  connectionId: string | undefined,
  runtimeEnvironmentId: string | null | undefined
): ConflictTransport {
  if (connectionId) {
    return 'ssh'
  }
  if (runtimeEnvironmentId?.trim()) {
    return 'runtime'
  }
  return 'local'
}

export function trackExternalChangeConflictShown(
  file: Pick<OpenFile, 'mode' | 'runtimeEnvironmentId'>,
  options: { connectionId: string | undefined; origin: 'live' | 'restore' }
): void {
  track('editor_external_change_conflict_shown', {
    surface: conflictSurface(file),
    transport: conflictTransport(options.connectionId, file.runtimeEnvironmentId),
    origin: options.origin
  })
}

export function trackExternalChangeConflictAction(
  file: Pick<OpenFile, 'mode' | 'worktreeId' | 'filePath' | 'runtimeEnvironmentId'>,
  action: ExternalChangeConflictAction
): void {
  track('editor_external_change_conflict_action', {
    action,
    surface: conflictSurface(file),
    // Keep transport on actions too so dismissal/resolution can be compared against shown-banner rates.
    transport: conflictTransport(
      getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
      file.runtimeEnvironmentId
    )
  })
}
