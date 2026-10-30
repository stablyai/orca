import type { TerminalLinkCommit } from './terminal-link-activation-operation'
import type { Terminal } from '@xterm/xterm'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { isTerminalOwnedLinkGesture } from './terminal-link-activation'
import { handleOscLink } from './terminal-osc-link-routing'
import {
  findHttpLinkAtTerminalMouseEvent,
  handleTerminalHttpLink,
  type TerminalHttpLinkActionDestinations,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { TerminalLinkActionContext } from './terminal-link-action-request'

type TerminalWebLinkClickDeps = Pick<
  LinkHandlerDeps,
  | 'worktreeId'
  | 'worktreePath'
  | 'startupCwd'
  | 'runtimeEnvironmentId'
  | 'terminalHomePath'
  | 'sourceTabId'
> & {
  commit?: TerminalLinkCommit
  terminal: Terminal | null
  sourceOwner?: HttpLinkSourceOwner
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
  linkActionContext?: TerminalLinkActionContext | null
  actionDestinations?: TerminalHttpLinkActionDestinations
}

export function handleTerminalWebLinkClick(
  url: string,
  event: MouseEvent | undefined,
  deps: TerminalWebLinkClickDeps
): boolean {
  if (!event || !isTerminalOwnedLinkGesture(event)) {
    return false
  }

  const completeUrl = deps.terminal ? findHttpLinkAtTerminalMouseEvent(deps.terminal, event) : null
  return completeUrl
    ? handleTerminalHttpLink(completeUrl, event, {
        worktreeId: deps.worktreeId,
        sourceTabId: deps.sourceTabId,
        sourceOwner:
          deps.sourceOwner ??
          (deps.runtimeEnvironmentId
            ? { kind: 'runtime', runtimeEnvironmentId: deps.runtimeEnvironmentId }
            : { kind: 'local' }),
        requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference,
        linkActionContext: deps.linkActionContext,
        commit: deps.commit,
        actionDestinations: deps.actionDestinations
      })
    : handleOscLink(url, event, deps)
}
