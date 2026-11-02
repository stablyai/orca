import {
  buildHttpLinkActions,
  httpLinkActionDestinationsFor,
  type HttpLinkActionDestinations
} from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { AppState } from '@/store/types'
import {
  buildFileLinkActions,
  type FileLinkActions,
  type TerminalFileLinkActionDeps
} from '@/components/terminal-pane/terminal-file-link-actions'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import { useAppStore } from '../../store'
import {
  resolveNativeChatFileLink,
  type NativeChatFileLinkContext,
  type NativeChatResolvedFileLink
} from './native-chat-file-link'
import {
  canNativeChatOpenOwnedBrowser,
  resolveNativeChatHttpLinkSourceOwner
} from './native-chat-http-link-source-owner'
import { openNativeChatWebLink } from './native-chat-web-link-actions'
import {
  showFileLinkNotFoundToast,
  showFileLinkUnverifiableToast
} from './native-chat-file-link-toasts'

/** Who owns a chat http(s) link and where it may open: the rows its popover and menu offer. */
export function resolveNativeChatHttpLinkRouting(
  state: AppState,
  worktreeId: string
): { sourceOwner: HttpLinkSourceOwner; destinations: HttpLinkActionDestinations } {
  const sourceOwner = resolveNativeChatHttpLinkSourceOwner(state, worktreeId)
  return {
    sourceOwner,
    destinations: httpLinkActionDestinationsFor(
      state.settings,
      sourceOwner,
      canNativeChatOpenOwnedBrowser(state, worktreeId, sourceOwner)
    )
  }
}

/** How a chat file link opens; an underlined link must answer every open, so a miss says why. */
export function nativeChatFileOpenDeps(
  target: NativeChatResolvedFileLink,
  context: NativeChatFileLinkContext
): TerminalFileLinkActionDeps {
  return {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    runtimeEnvironmentId: context.runtimeEnvironmentId,
    onOpenFailure: (failure) =>
      failure.verdict === 'unverifiable'
        ? showFileLinkUnverifiableToast(target.absolutePath, failure.error)
        : showFileLinkNotFoundToast(target.absolutePath)
  }
}

/** The rows a chat file link offers, on click and on right-click alike. */
export function nativeChatFileLinkActions(
  target: NativeChatResolvedFileLink,
  context: NativeChatFileLinkContext
): FileLinkActions {
  return buildFileLinkActions(
    target.absolutePath,
    target.line,
    target.column,
    nativeChatFileOpenDeps(target, context),
    resolveNativeChatHttpLinkSourceOwner(useAppStore.getState(), context.worktreeId)
  )
}

/** The rows a right-clicked chat link offers: its click popover's, or null when it opens nothing. */
export function nativeChatLinkActions(
  href: string,
  context: NativeChatFileLinkContext | null
): FileLinkActions | null {
  if (!context) {
    return null
  }
  const route = routeNativeChatHref(href)
  if (route.kind === 'file') {
    const target = resolveNativeChatFileLink(href, context)
    return target ? nativeChatFileLinkActions(target, context) : null
  }
  if (route.kind !== 'web' || !/^https?:/i.test(route.url)) {
    return null
  }
  const routing = resolveNativeChatHttpLinkRouting(useAppStore.getState(), context.worktreeId)
  return {
    destination: route.url,
    kind: 'url',
    ...buildHttpLinkActions(routing.destinations, (destination) =>
      openNativeChatWebLink(
        route.url,
        { worktreeId: context.worktreeId, sourceOwner: routing.sourceOwner },
        destination
      )
    )
  }
}
