import {
  prepareTerminalLinkActivation,
  commitTerminalLinkActivation,
  type TerminalLinkCommit
} from './terminal-link-activation-operation'
import { showFileLinkOpenFailureToast } from '@/lib/file-link-open-failure-toast'
import { requestTerminalLinkAction } from './terminal-link-action-request'
import { showFileLinkUnresolvedToast } from '@/components/native-chat/native-chat-file-link-toasts'
import { resolveTerminalFileLink } from '../../../../shared/terminal-links'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { classifyTerminalOscLinkTarget } from '../../../../shared/terminal-osc-link-target'
import {
  isTerminalLinkActionActivation,
  isTerminalLinkContextMenuActivation,
  isTerminalLinkDirectActivation
} from './terminal-link-activation'
import {
  handleTerminalHttpLink,
  type TerminalHttpLinkActionDestinations,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import {
  handleTerminalFileLink,
  type TerminalFileLinkActionDeps
} from './terminal-file-link-actions'

type TerminalLinkEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'> &
  Partial<
    Pick<
      MouseEvent,
      | 'altKey'
      | 'button'
      | 'clientX'
      | 'clientY'
      | 'shiftKey'
      | 'preventDefault'
      | 'stopPropagation'
      | 'type'
    >
  >

function isDesktopOscLinkActivation(event: TerminalLinkEvent | undefined): boolean {
  if (!event) {
    return false
  }
  if (isTerminalLinkContextMenuActivation(event)) {
    return true
  }
  if ('button' in event && event.button !== undefined && event.button !== 0) {
    return false
  }
  // Desktop links require an intentional gesture; ordinary clicks/selecting must not open them. Mobile taps use WebView routing.
  return isTerminalLinkDirectActivation(event) || isTerminalLinkActionActivation(event)
}

export function handleOscLink(
  rawText: string,
  event: TerminalLinkEvent | undefined,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'> &
    Partial<
      Pick<
        LinkHandlerDeps,
        'runtimeEnvironmentId' | 'startupCwd' | 'terminalHomePath' | 'wslDistro' | 'sourceTabId'
      >
    > & {
      commit?: TerminalLinkCommit
      fileContext?: TerminalFileLinkActionDeps['fileContext']
      onInternalOpen?: () => void
      onOpenFailure?: TerminalFileLinkActionDeps['onOpenFailure']
      sourceOwner?: HttpLinkSourceOwner
      requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
      linkActionContext?: TerminalLinkActionContext | null
      actionDestinations?: TerminalHttpLinkActionDestinations
    }
): boolean {
  if (!isDesktopOscLinkActivation(event)) {
    return false
  }
  const finish = (handled: boolean): boolean => {
    if (handled) {
      // Why: prevent anchor navigation without blocking xterm's document-level selection cleanup.
      event?.preventDefault?.()
    }
    return handled
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the link handlers read only the MouseEvent fields TerminalLinkEvent picks.
  const mouseEvent = event as MouseEvent
  const cwd = deps.startupCwd ?? deps.worktreePath
  const target = classifyTerminalOscLinkTarget(rawText, {
    windowsPathsFirst: isWindowsAbsolutePathLike(cwd || deps.worktreePath),
    // Reject foreign file hosts except standard Windows UNC file://server/share paths.
    allowUncHost:
      navigator.userAgent.includes('Windows') &&
      isWindowsAbsolutePathLike(deps.worktreePath) &&
      !deps.runtimeEnvironmentId
  })
  if (target?.kind === 'url') {
    return finish(
      handleTerminalHttpLink(target.url, mouseEvent, {
        worktreeId: deps.worktreeId,
        sourceTabId: deps.sourceTabId,
        sourceOwner:
          deps.sourceOwner ??
          (deps.runtimeEnvironmentId
            ? { kind: 'runtime', runtimeEnvironmentId: deps.runtimeEnvironmentId }
            : { kind: 'local' }),
        requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference,
        linkActionContext: deps.linkActionContext,
        actionDestinations: deps.actionDestinations,
        commit: deps.commit,
        actionDestination: rawText
      })
    )
  }
  if (!cwd && !deps.worktreePath) {
    return false
  }
  const file =
    target?.kind === 'file-url'
      ? {
          absolutePath: target.target.filePath,
          line: target.target.line,
          column: target.target.column
        }
      : target?.kind === 'path'
        ? resolveTerminalFileLink(target.link, cwd, deps.terminalHomePath)
        : null
  if (!file) {
    if (target?.kind === 'path') {
      const report = (): void => showFileLinkUnresolvedToast(target.link.pathText)
      if (isTerminalLinkDirectActivation(mouseEvent)) {
        return commitTerminalLinkActivation(
          mouseEvent,
          prepareTerminalLinkActivation(mouseEvent, {
            kind: 'unresolved',
            direct: report,
            details: report
          }),
          deps.commit ?? deps.linkActionContext?.commit
        )
      }
      return finish(requestTerminalLinkAction(mouseEvent, deps.linkActionContext, report))
    }
    return false
  }
  return finish(
    handleTerminalFileLink(
      file.absolutePath,
      file.line,
      file.column,
      mouseEvent,
      {
        ...deps,
        onOpenFailure:
          deps.onOpenFailure ??
          ((failure) => showFileLinkOpenFailureToast(file.absolutePath, failure))
      },
      deps.linkActionContext,
      rawText
    )
  )
}
