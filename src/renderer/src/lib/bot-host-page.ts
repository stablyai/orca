// Where a sign-in page for a host's bots opens. This app's own bots: as before. A paired server's
// bots: always in that server's own page in Orca's browser, whatever the link setting says, so the
// page has the server's own logins and its traffic, a 127.0.0.1 return included, goes through the
// server. The link setting still picks foreground or background there.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import { resolveNativeChatHttpLinkSourceOwner } from '@/components/native-chat/links/actions/native-chat-http-link-source-owner'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  isExpectedSshBrowserRoute
} from './browser/workspace/workspace-browser-route-eligibility'
import { getWorkspaceClientCreationActionPolicy } from './workspace/creation/surface-policy/client-creation-action-policy'
import { resolveWorktreeOperationRoute } from './workspace/ownership/worktree-operation-route'
import type { AppState } from '@/store/types'
import { openBotToolSignInPage } from '@/components/bots/bot-tool-sign-in-state'
import { openAppHttpLink } from './browser/navigation/app-http-link-open'
import type {
  HttpLinkDestination,
  HttpLinkSourceOwner
} from './browser/navigation/http-link-routing'
import { readBots } from './bot-catalog-snapshot'
import { isSameBot, type BotRef } from './bot-hosts'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

export type BotHostPageOptions = {
  /** The bot the page is for, whose workspace it must open in; without one, any bot of the host
   *  lends its workspace. */
  bot?: BotRef
  /** This app's own bots: `system` opens the system browser, `link-setting` follows "Open links in Orca". */
  local: 'system' | 'link-setting'
}

/** Opens the page; `unrouted` when a server's page couldn't open in its own session, so nothing opened. */
export function openBotHostPage(
  hostId: ExecutionHostId,
  url: string,
  options: BotHostPageOptions
): HttpLinkDestination | 'unrouted' {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    if (options.local === 'link-setting') {
      return openAppHttpLink(url)
    }
    openBotToolSignInPage(url)
    return 'system-browser'
  }
  return openOnServer(hostId, url, options.bot) ? 'orca-browser' : 'unrouted'
}

/**
 * Opens the page as `openBotHostPage` does, and says so when a server's couldn't open in its own
 * session: it never falls back to this computer's browser, whose logins aren't the server's.
 */
export function openBotHostPageOrSay(
  hostId: ExecutionHostId,
  url: string,
  options: BotHostPageOptions
): HttpLinkDestination | 'unrouted' {
  const opened = openBotHostPage(hostId, url, options)
  if (opened === 'unrouted') {
    toast.error(
      options.bot && !hostBot(hostId, options.bot)
        ? translate(
            'bots.host.botWorkspaceUnavailable',
            'This agent’s workspace isn’t available here now, so the page can’t open in it.'
          )
        : botHostUnroutedMessage(hostId)
    )
  }
  return opened
}

/** Why a server's page opened nowhere: Orca's browser for it isn't reachable now. */
export function botHostUnroutedMessage(hostId: ExecutionHostId): string {
  const host = selectExecutionHostDisplayLabel(useAppStore.getState(), hostId)
  return translate(
    'bots.host.pageUnrouted',
    'Can’t reach {{host}} to open this page in its browser. Reconnect {{host}}, then try again.',
    { host }
  )
}

/** The named bot, or with none named any bot of the host; never another bot in place of the named. */
function hostBot(hostId: ExecutionHostId, ref?: BotRef) {
  const bots = readBots()
  return ref
    ? bots.find((entry) => isSameBot(entry, ref))
    : bots.find((entry) => entry.hostId === hostId)
}

/** Opens the page in a workspace of the host's bots, only if that page's owner is the host itself. */
export function openOnServer(hostId: ExecutionHostId, url: string, ref?: BotRef): boolean {
  const bot = hostBot(hostId, ref)
  if (!bot) {
    return false
  }
  const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
  // An Orca-browser page is owned as resolved here; routed only when that owner is another computer.
  const state = useAppStore.getState()
  const owner = resolveNativeChatHttpLinkSourceOwner(state, worktreeId)
  // Decided before opening: a link the workspace's browser can't host would go to the system browser.
  if (
    (owner.kind !== 'runtime' && owner.kind !== 'ssh') ||
    !canOpenServerOwnedBrowser(state, worktreeId, owner)
  ) {
    return false
  }
  return openAppHttpLink(url, { worktreeId, forceInApp: true }) === 'orca-browser'
}

// The server's own browser only: never this device's, even when its SSH host browses from here.
function canOpenServerOwnedBrowser(
  state: AppState,
  worktreeId: string,
  owner: HttpLinkSourceOwner
): boolean {
  if (owner.kind === 'runtime') {
    return canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, owner.runtimeEnvironmentId)
  }
  return (
    owner.kind === 'ssh' &&
    isExpectedSshBrowserRoute(
      state,
      getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser'],
      resolveWorktreeOperationRoute(state, worktreeId),
      worktreeId,
      owner.connectionId
    )
  )
}
