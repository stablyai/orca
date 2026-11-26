/** `refused`: stopped before anything changed; `perforce`/`copy`: a step failed (create rolls back). */
export type WorkspaceCopyErrorKind = 'usage' | 'refused' | 'perforce' | 'copy'

export class WorkspaceCopyError extends Error {
  readonly kind: WorkspaceCopyErrorKind

  constructor(kind: WorkspaceCopyErrorKind, message: string) {
    super(message)
    this.name = 'WorkspaceCopyError'
    this.kind = kind
  }
}
