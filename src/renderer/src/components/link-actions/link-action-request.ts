import type { HttpLinkAction } from '@/lib/browser/navigation/http-link-destinations'

export type LinkActionKind = 'url' | 'file' | 'workspace' | 'terminal' | 'task'

export type LinkAction = HttpLinkAction

/** A pending destination choice for one clicked link, anchored at the pointer. */
export type LinkActionRequest = {
  anchorX: number
  anchorY: number
  destination: string
  /** Copied instead of destination when the shown target differs from the resolved path. */
  copyValue?: string
  kind: LinkActionKind
  primary: LinkAction
  alternate?: LinkAction
  /** Rows after primary/alternate that have no click shortcut. */
  secondaryActions?: readonly LinkAction[]
  /** Hands focus back to the surface that owned the click (terminal, chat transcript). */
  restoreFocus: () => void
  /** Desktop URL choosers opened by a plain click in Ask mode with both browsers and a qualified click host. */
  rememberEligible?: boolean
  /** URL choosers in chat, terminal and dashboard: the keyboard model applies. Every desktop URL gear opens Links. */
  linkPreferenceHost?: boolean
}

export function closeLinkActionRequest<T extends LinkActionRequest>(
  current: T | null,
  dismissed?: T
): T | null {
  return dismissed && current !== dismissed ? current : null
}
