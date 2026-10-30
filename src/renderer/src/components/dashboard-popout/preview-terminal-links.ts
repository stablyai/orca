import {
  installTerminalLinkPtyMouseSuppression,
  type TerminalLinkPtyMouseSuppression
} from '../terminal-pane/terminal-link-pty-mouse-suppression'
import { terminalLinkPressCandidate } from '../terminal-pane/terminal-link-press-candidate'
import { isTerminalLinkDirectActivation } from '../terminal-pane/terminal-link-activation'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { installGuardedLinkProviderRegistration } from '@/lib/pane-manager/terminal-link-provider-guard'
import { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'
import { installTerminalLinkPointerGesture } from '@/components/terminal-pane/terminal-link-pointer-gesture'
import { terminalLinkClickBehaviorFor } from '@/components/terminal-pane/terminal-link-click-behavior'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import type { TerminalLinkActionRequester } from '@/components/terminal-pane/terminal-link-action-request'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TERMINAL_HTTP_URL_REGEX } from '../../../../shared/terminal-http-url-extraction'
import { previewTerminalLinkContext } from './preview-terminal-link-context'
import { httpLinkDirectClickDestination } from '@/lib/http-link-destinations'
import { isHttpLinkBackgroundOpen } from '@/lib/http-link-browser-placement'
import type { LinkAction } from '@/components/link-actions/link-action-request'

export type PreviewTerminalLinkRouting = {
  getContext: () => ReturnType<typeof previewTerminalLinkContext>
  request: TerminalLinkActionRequester
  onNavigate?: () => void
}

/** Share pane actions for OSC and detected URLs; retain the preview's single URL provider. */
export function installPreviewTerminalLinks(
  terminal: Pick<
    Terminal,
    | 'buffer'
    | 'cols'
    | 'rows'
    | 'element'
    | 'options'
    | 'hasSelection'
    | 'clearSelection'
    | 'focus'
    | 'loadAddon'
    | 'registerLinkProvider'
  >,
  deps: {
    getSettings: () => Pick<
      GlobalSettings,
      | 'terminalRightClickToPaste'
      | 'terminalLinkClickBehavior'
      | 'terminalLinkActionPopoverEnabled'
      | 'openLinksInAppInBackground'
    > | null
    linkRouting?: PreviewTerminalLinkRouting
  }
): (() => void) & { inputOwner: TerminalLinkPtyMouseSuppression } {
  installGuardedLinkProviderRegistration(terminal)
  const pointerGesture = deps.linkRouting ? installTerminalLinkPointerGesture(terminal) : null
  let hoveredLink: string | null = null
  const inputOwner = installTerminalLinkPtyMouseSuppression(terminal, {
    candidate: (event) => terminalLinkPressCandidate(terminal, event),
    eligible: (event) => {
      const contextPress =
        event.button === 2 ||
        (getShortcutPlatform() === 'darwin' && event.button === 0 && event.ctrlKey)
      if (contextPress) {
        return Boolean(deps.linkRouting)
      }
      return (
        event.button === 0 &&
        (isTerminalLinkDirectActivation(event) ||
          Boolean(
            pointerGesture?.canRequestAction(event) &&
            terminalLinkClickBehaviorFor(deps.getSettings()) !== 'none'
          ))
      )
    },
    canContinue: (event) => Boolean(pointerGesture?.canRequestAction(event))
  })
  const activate = (event: MouseEvent, uri: string): boolean => {
    const context = deps.linkRouting?.getContext() ?? previewTerminalLinkContext()
    let requested = false
    const navigate = (): void => deps.linkRouting?.onNavigate?.()
    const browserAction = (action: LinkAction): LinkAction => ({
      ...action,
      run: () => {
        if (!action.external && !isHttpLinkBackgroundOpen({ settings: deps.getSettings() })) {
          navigate()
        }
        return action.run()
      }
    })
    const handled = handleOscLink(uri, event, {
      ...context,
      commit: inputOwner.commit,
      onInternalOpen: navigate,
      linkActionContext: deps.linkRouting &&
        pointerGesture && {
          paneId: 0,
          pointerGesture,
          commit: inputOwner.commit,
          request: (request) => {
            requested = true
            deps.linkRouting?.request(
              request.kind === 'url'
                ? {
                    ...request,
                    primary: browserAction(request.primary),
                    alternate: request.alternate && browserAction(request.alternate),
                    secondaryActions: request.secondaryActions?.map(browserAction)
                  }
                : request
            )
          },
          focusTerminal: () => terminal.focus(),
          plainClickBehavior: terminalLinkClickBehaviorFor(deps.getSettings()),
          sourceOwner: context.sourceOwner
        }
    })
    if (
      handled &&
      !requested &&
      /^https?:/i.test(uri) &&
      httpLinkDirectClickDestination(
        context.actionDestinations ?? { primary: 'system' },
        event.shiftKey
      ) === 'orca' &&
      !isHttpLinkBackgroundOpen({ settings: deps.getSettings() })
    ) {
      navigate()
    }
    return handled
  }
  const hover = (_event: MouseEvent, uri: string): void => {
    hoveredLink = uri
  }
  const leave = (): void => {
    hoveredLink = null
  }
  const previousHandler = terminal.options.linkHandler
  const linkHandler = { allowNonHttpProtocols: true, activate, hover, leave }
  terminal.options.linkHandler = linkHandler
  terminal.loadAddon(
    new WebLinksAddon(activate, { urlRegex: TERMINAL_HTTP_URL_REGEX, hover, leave })
  )
  const contextMenu = (event: MouseEvent): void => {
    const rightClickPaste = deps.getSettings()?.terminalRightClickToPaste ?? isWindowsUserAgent()
    if ((!rightClickPaste || event.ctrlKey) && hoveredLink && activate(event, hoveredLink)) {
      event.stopPropagation()
    }
  }
  terminal.element?.addEventListener('contextmenu', contextMenu)
  return Object.assign(
    () => {
      try {
        inputOwner.dispose()
      } finally {
        pointerGesture?.dispose()
        terminal.element?.removeEventListener('contextmenu', contextMenu)
        if (terminal.options.linkHandler === linkHandler) {
          terminal.options.linkHandler = previousHandler
        }
      }
    },
    { inputOwner }
  )
}
