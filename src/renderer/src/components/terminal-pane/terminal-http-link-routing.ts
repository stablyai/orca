import {
  canRouteHttpLinkToOrcaBrowser,
  type TerminalHttpRouteMode
} from '../../lib/http-link-routing'
import { translate } from '@/i18n/i18n'

export type TerminalHttpRouteContext = {
  worktreeId?: string | null
  openLinksInApp?: boolean
  activeRuntimeEnvironmentId?: string | null
  runtimeEnvironmentId?: string | null
  connectionId?: string | null
}

type TerminalHttpLinkEvent = Partial<Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>>

export type TerminalBrowserTipNotifier = (
  context: TerminalHttpRouteContext
) => void | Promise<void> | null | undefined

function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Mac')
}

function getPrimaryModifierPressed(event: TerminalHttpLinkEvent): boolean {
  return isMacPlatform() ? event.metaKey === true : event.ctrlKey === true
}

export function getTerminalHttpRouteModeForEvent(
  event: TerminalHttpLinkEvent
): TerminalHttpRouteMode {
  if (event.shiftKey === true && getPrimaryModifierPressed(event)) {
    return 'alternate'
  }
  if (event.shiftKey === true) {
    return 'force-system'
  }
  return 'default'
}

export function canTerminalRouteHttpLinkToOrcaBrowser(context: TerminalHttpRouteContext): boolean {
  return canRouteHttpLinkToOrcaBrowser(
    {
      worktreeId: context.worktreeId,
      runtimeEnvironmentId: context.runtimeEnvironmentId,
      connectionId: context.connectionId
    },
    context.activeRuntimeEnvironmentId
  )
}

export function getTerminalHttpAlternateShortcutLabel(): string {
  return isMacPlatform() ? '⇧⌘-click' : 'Shift+Ctrl-click'
}

export function getTerminalHttpUrlOpenHint(context: TerminalHttpRouteContext): string {
  const shortcut = getTerminalHttpAlternateShortcutLabel()
  // Why: remote/SSH links cannot route into the local Orca Browser even after
  // settings hydrate, so capability copy must win over settings-loading copy.
  if (!canTerminalRouteHttpLinkToOrcaBrowser(context)) {
    return translate(
      'auto.components.terminalPane.terminalHttpLinkRouting.localTerminalsOnlyHint',
      'Click opens system browser; Orca Browser routing is available for local terminals.'
    )
  }
  if (context.openLinksInApp === undefined) {
    return translate(
      'auto.components.terminalPane.terminalHttpLinkRouting.settingsLoadingHint',
      'Click opens system browser; Orca Browser routing is available after settings load.'
    )
  }
  if (context.openLinksInApp === true) {
    return translate(
      'auto.components.terminalPane.terminalHttpLinkRouting.orcaDefaultHint',
      'Click opens in Orca; {{value0}} opens system browser once.',
      { value0: shortcut }
    )
  }
  return translate(
    'auto.components.terminalPane.terminalHttpLinkRouting.systemDefaultHint',
    'Click opens system browser; {{value0}} opens in Orca once.',
    { value0: shortcut }
  )
}

export function getTerminalHttpBrowserTipCopy(context: TerminalHttpRouteContext): {
  title: string
  description: string
} {
  const shortcut = getTerminalHttpAlternateShortcutLabel()
  if (!canTerminalRouteHttpLinkToOrcaBrowser(context)) {
    return {
      title: translate(
        'auto.components.terminalPane.terminalHttpLinkRouting.systemBrowserHereTitle',
        'Terminal links use your system browser here'
      ),
      description: translate(
        'auto.components.terminalPane.terminalHttpLinkRouting.localTerminalRoutingDescription',
        'Orca Browser link routing is available for local terminal links in Settings -> Browser.'
      )
    }
  }
  if (context.openLinksInApp === true) {
    return {
      title: translate(
        'auto.components.terminalPane.terminalHttpLinkRouting.orcaDefaultTitle',
        'Terminal links open in Orca Browser'
      ),
      description: translate(
        'auto.components.terminalPane.terminalHttpLinkRouting.orcaDefaultDescription',
        'Use {{value0}} for your system browser, or change Link Routing in Settings -> Browser.',
        { value0: shortcut }
      )
    }
  }
  return {
    title: translate(
      'auto.components.terminalPane.terminalHttpLinkRouting.systemDefaultTitle',
      'Terminal links can open in Orca Browser'
    ),
    description: translate(
      'auto.components.terminalPane.terminalHttpLinkRouting.systemDefaultDescription',
      'Use {{value0}} once, or turn on Link Routing in Settings -> Browser.',
      { value0: shortcut }
    )
  }
}
