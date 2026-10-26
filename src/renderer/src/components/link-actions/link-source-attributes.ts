import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'

/** Names the workspace a link belongs to, on the link or an ancestor; its owner resolves from it. */
export const LINK_WORKTREE_ATTRIBUTE = 'data-orca-link-worktree-id'
/** Set by surfaces that already resolved their link owner, such as the markdown preview. */
export const LINK_OWNER_ATTRIBUTE = 'data-orca-link-owner'

export function encodeLinkSourceOwner(owner: HttpLinkSourceOwner): string {
  switch (owner.kind) {
    case 'runtime':
      return `runtime:${owner.runtimeEnvironmentId}`
    case 'ssh':
      return `ssh:${owner.connectionId}`
    case 'local':
    case 'unknown':
      return owner.kind
  }
}

export function decodeLinkSourceOwner(value: string): HttpLinkSourceOwner {
  const separator = value.indexOf(':')
  const kind = separator === -1 ? value : value.slice(0, separator)
  const id = separator === -1 ? '' : value.slice(separator + 1)
  if (kind === 'local') {
    return { kind: 'local' }
  }
  if (kind === 'runtime' && id) {
    return { kind: 'runtime', runtimeEnvironmentId: id }
  }
  if (kind === 'ssh' && id) {
    return { kind: 'ssh', connectionId: id }
  }
  return { kind: 'unknown' }
}
