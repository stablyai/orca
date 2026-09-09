/**
 * Which host owns a document, as the renderer names it.
 *
 * Mirrors `DocPreviewOwner` and adds the `local` case a grant never needs but execution always
 * does. The renderer resolves this the same way it resolves a preview grant's owner — from the
 * worktree's connection or runtime environment — so one workspace cannot be two different hosts
 * depending on which feature asked.
 */
export type OfficeHostOwner =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string }

export function officeHostOwnerKey(owner: OfficeHostOwner): string {
  switch (owner.kind) {
    case 'local':
      return 'local'
    case 'ssh':
      return `ssh:${owner.connectionId}`
    case 'runtime':
      return `runtime:${owner.environmentId}`
  }
}

export function isValidOfficeHostOwner(value: unknown): value is OfficeHostOwner {
  const owner = value as OfficeHostOwner | null
  if (!owner || typeof owner !== 'object') {
    return false
  }
  // Not a switch: this validates a value off the wire, so the compiler's exhaustiveness over the
  // union says nothing about what actually arrived, and a `default` on an exhaustive switch is
  // itself a lint finding. An explicit table keeps the unknown-kind case reachable and honest.
  if (owner.kind === 'local') {
    return true
  }
  if (owner.kind === 'ssh') {
    return typeof owner.connectionId === 'string' && owner.connectionId.trim().length > 0
  }
  if (owner.kind === 'runtime') {
    return typeof owner.environmentId === 'string' && owner.environmentId.trim().length > 0
  }
  return false
}
