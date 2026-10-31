import type { PreviewTerminalLinkHandler } from './preview-terminal-links'
import type { Terminal } from '@xterm/xterm'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { installTerminalLinkifierClickPriming } from '@/components/terminal-pane/terminal-linkifier-click-priming'
import { installTerminalLinkPointerGesture } from '@/components/terminal-pane/terminal-link-pointer-gesture'
import { installTerminalLinkPtyMouseSuppression } from '@/components/terminal-pane/terminal-link-pty-mouse-suppression'
import { requestTerminalLinkAction } from '@/components/terminal-pane/terminal-link-action-request'
import { terminalLinkClickBehaviorFor } from '@/components/terminal-pane/terminal-link-click-behavior'
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation
} from '@/components/terminal-pane/terminal-link-activation'
import { getTerminalBufferPositionForMouseEvent } from '@/components/terminal-pane/terminal-mouse-buffer-position'
import { findHttpLinkAtTerminalMouseEvent } from '@/components/terminal-pane/terminal-url-link-hit-testing'
import { findTerminalHttpLinkAtBufferPosition } from '../../../../shared/terminal-link-buffer-hit-testing'
import { httpLinkDirectClickDestination } from '@/lib/http-link-destinations'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  dashboardPreviewHttpActions,
  type DashboardPreviewLinkSource
} from './dashboard-preview-http-actions'

export function installDashboardPreviewLinkInteraction(
  terminal: Terminal,
  deps: {
    defaultHandlers?: PreviewTerminalLinkHandler
    getSettings: () => GlobalSettings | null
    getSource: () => DashboardPreviewLinkSource | undefined
    onForegroundOpen: () => (() => void) | undefined
    request: (request: LinkActionRequest | null) => void
    sendInput: (data: string) => boolean | Promise<boolean>
  }
) {
  const element = terminal.element
  let disposed = false
  let hovered: {
    uri: string
    range: { start: { x: number; y: number }; end: { x: number; y: number } }
  } | null = null
  const isActionUri = (uri: string): boolean => /^https?:\/\//i.test(uri)
  const actionsFor = (uri: string) => {
    const source = deps.getSource()
    return !disposed && source
      ? dashboardPreviewHttpActions(
          source,
          uri,
          deps.onForegroundOpen()
            ? () => {
                if (!disposed) {
                  deps.onForegroundOpen()?.()
                }
              }
            : undefined
        )
      : null
  }
  const target = (event: MouseEvent): string | null => {
    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    if (!position) {
      return null
    }
    if (
      hovered &&
      position.y >= hovered.range.start.y &&
      position.y <= hovered.range.end.y &&
      (position.y !== hovered.range.start.y || position.x >= hovered.range.start.x) &&
      (position.y !== hovered.range.end.y || position.x <= hovered.range.end.x)
    ) {
      return hovered.uri
    }
    return findTerminalHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols)
  }
  const primer = installTerminalLinkifierClickPriming(terminal)
  const gesture = installTerminalLinkPointerGesture(terminal)
  const enabledTarget = (event: MouseEvent): boolean => {
    if (event.button !== 0) {
      return false
    }
    const uri = target(event)
    return Boolean(uri && actionsFor(uri))
  }
  const suppression = installTerminalLinkPtyMouseSuppression(
    terminal,
    enabledTarget,
    (event) =>
      terminalLinkClickBehaviorFor(deps.getSettings()) !== 'none' &&
      gesture.canRequestAction(event) &&
      enabledTarget(event),
    (event) => gesture.canRequestAction(event)
  )
  const activate = (
    event: MouseEvent,
    uri: string,
    range?: Parameters<PreviewTerminalLinkHandler['activate']>[2]
  ): void => {
    if (!isActionUri(uri)) {
      if (!disposed && range) {
        deps.defaultHandlers?.activate(event, uri, range)
      }
      return
    }
    if (event.defaultPrevented || event.button !== 0) {
      return
    }
    const actions = actionsFor(uri)
    if (!actions) {
      return
    }
    let handled = false
    if (isTerminalLinkDirectActivation(event)) {
      event.preventDefault()
      actions.open(httpLinkDirectClickDestination(actions.destinations, event.shiftKey))
      handled = true
    } else {
      handled = requestTerminalLinkAction(
        event,
        {
          paneId: 0,
          pointerGesture: gesture,
          claimPtyMouse: suppression.claimAction,
          request: deps.request,
          focusTerminal: () => terminal.focus(),
          plainClickBehavior: terminalLinkClickBehaviorFor(deps.getSettings()),
          middleClickBehavior: 'none',
          sourceOwner: actions.owner
        },
        {
          destination: uri,
          copyValue: uri,
          kind: 'url',
          primary: actions.primary,
          alternate: actions.alternate,
          secondaryActions: actions.secondaryActions
        }
      )
    }
    if (handled) {
      terminal.clearSelection()
    }
  }
  const handlers: PreviewTerminalLinkHandler = {
    activate,
    hover: (event, uri, range) => {
      hovered = isActionUri(uri) ? { uri, range } : null
      deps.defaultHandlers?.hover?.(event, uri, range)
    },
    leave: (event, uri, range) => {
      hovered = null
      deps.defaultHandlers?.leave?.(event, uri, range)
    }
  }
  const fallback = (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      !(isTerminalLinkDirectActivation(event) || isTerminalLinkActionActivation(event))
    ) {
      return
    }
    const uri = findHttpLinkAtTerminalMouseEvent(terminal, event)
    if (uri) {
      activate(event, uri)
    }
  }
  const context = (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 2 ||
      event.ctrlKey ||
      event.metaKey ||
      terminal.hasSelection() ||
      (deps.getSettings()?.terminalRightClickToPaste ?? isWindowsUserAgent())
    ) {
      return
    }
    const uri = target(event)
    const actions = uri && actionsFor(uri)
    if (!uri || !actions) {
      return
    }
    event.preventDefault()
    deps.request({
      destination: uri,
      copyValue: uri,
      kind: 'url',
      anchorX: event.clientX,
      anchorY: event.clientY,
      primary: actions.primary,
      alternate: actions.alternate,
      secondaryActions: actions.secondaryActions,
      restoreFocus: () => terminal.focus()
    })
  }
  element?.addEventListener('mouseup', fallback)
  element?.addEventListener('contextmenu', context)
  let forwarded: boolean | Promise<boolean> | undefined
  const forward = (data: string): void => {
    forwarded = deps.sendInput(data)
  }
  return {
    handlers,
    sendInput: (data: string): boolean | Promise<boolean> => {
      forwarded = undefined
      suppression.handlePtyInput(data, forward)
      return forwarded ?? false
    },
    dispose: () => {
      disposed = true
      deps.request(null)
      hovered = null
      suppression.dispose()
      gesture.dispose()
      primer.dispose()
      element?.removeEventListener('mouseup', fallback)
      element?.removeEventListener('contextmenu', context)
      element?.removeAttribute('title')
    }
  }
}
