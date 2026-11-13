import {
  canNativeChatOpenOwnedBrowser,
  resolveNativeChatHttpLinkSourceOwner
} from '@/components/native-chat/links/actions/native-chat-http-link-source-owner'
import { getWorkspaceClientCreationActionPolicy } from '../../workspace/creation/surface-policy/client-creation-action-policy'
import { openOwnedHttpLink } from './http-link-routing'
import type { HttpLinkDestination, HttpLinkSourceOwner } from './http-link-routing'
import { getShortcutPlatform } from '../../keyboard/shortcut-platform'
import type { AppState } from '@/store/types'

// The store registers itself so link buttons need not import it.
let appStateAccessor: (() => AppState) | null = null

export function registerAppHttpLinkStateAccessor(fn: () => AppState): void {
  appStateAccessor = fn
}

type AppHttpLinkClick = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export type OpenAppHttpLinkOptions = {
  /** The workspace the link belongs to; defaults to the active one. */
  worktreeId?: string | null
  /** The click, so the setting's Shift escape modifier applies. */
  event?: AppHttpLinkClick
  /** Explicit destination override when a surface bypasses the link setting. */
  destination?: 'orca' | 'system'
}

function isEscapeModifierClick(event: AppHttpLinkClick | undefined): boolean {
  return Boolean(
    event?.shiftKey && (getShortcutPlatform() === 'darwin' ? event.metaKey : event.ctrlKey)
  )
}

/** Opens a web link from Orca's own UI per the link setting, in the given or active workspace. */
export function openAppHttpLink(
  url: string,
  options: OpenAppHttpLinkOptions = {}
): HttpLinkDestination {
  // Like the system-browser bridge, ignore anything that is not a web link.
  if (!/^https?:\/\//i.test(url)) {
    return 'none'
  }
  const state = appStateAccessor?.()
  const hostWorktreeId = options.worktreeId || state?.activeWorktreeId
  const host = state && hostWorktreeId ? resolveBrowserHost(state, hostWorktreeId) : null
  if (options.destination === 'system') {
    return openOwnedHttpLink(url, {
      worktreeId: host?.worktreeId ?? null,
      sourceOwner: host?.owner ?? LOCAL_OWNER,
      forceSystemBrowser: true
    })
  }
  if (options.destination === 'orca') {
    return openOwnedHttpLink(url, {
      worktreeId: host?.worktreeId ?? null,
      sourceOwner: host?.owner ?? LOCAL_OWNER,
      allowRemoteInApp: Boolean(host),
      forceInApp: Boolean(host),
      forceSystemBrowser: !host
    })
  }
  return openOwnedHttpLink(url, {
    worktreeId: host?.worktreeId ?? null,
    sourceOwner: host?.owner ?? LOCAL_OWNER,
    allowRemoteInApp: true,
    modifierHeld: isEscapeModifierClick(options.event)
  })
}

const LOCAL_OWNER: HttpLinkSourceOwner = { kind: 'local' }

/** The workspace's browser hosts the link under its own owner; without one, the system browser does. */
function resolveBrowserHost(
  state: AppState,
  worktreeId: string
): { worktreeId: string; owner: HttpLinkSourceOwner } | null {
  const owner = resolveNativeChatHttpLinkSourceOwner(state, worktreeId)
  const canHost =
    owner.kind === 'local'
      ? getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser'].state ===
        'enabled'
      : canNativeChatOpenOwnedBrowser(state, worktreeId, owner)
  return canHost ? { worktreeId, owner } : null
}

type AppHttpLinkAnchorClick = AppHttpLinkClick &
  Pick<MouseEvent, 'button' | 'altKey' | 'preventDefault'> & { currentTarget: HTMLAnchorElement }

/** Routes plain and escape-modifier anchor clicks; other modifier clicks keep the browser default. */
export function openAppHttpLinkFromAnchor(
  event: AppHttpLinkAnchorClick,
  worktreeId?: string | null
): void {
  const anchor = event.currentTarget
  const plainClick = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  if (
    event.button !== 0 ||
    !/^https?:$/.test(anchor.protocol) ||
    !(plainClick || isEscapeModifierClick(event))
  ) {
    return
  }
  event.preventDefault()
  openAppHttpLink(anchor.href, { worktreeId, event })
}
