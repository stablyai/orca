import type { HttpLinkAction } from '@/lib/http-link-destinations'

export type LinkActionKind = 'url' | 'file' | 'workspace' | 'terminal' | 'task'

export type LinkAction = HttpLinkAction

/** A pending destination choice for one clicked link, anchored at the pointer. */
export type LinkActionRequest = {
  anchorX: number
  anchorY: number
  destination: string
  kind: LinkActionKind
  primary: LinkAction
  alternate?: LinkAction
  /** Hands focus back to the surface that owned the click (terminal, chat transcript). */
  restoreFocus: () => void
}

export function closeLinkActionRequest<T extends LinkActionRequest>(
  current: T | null,
  dismissed?: T
): T | null {
  return dismissed && current !== dismissed ? current : null
}
