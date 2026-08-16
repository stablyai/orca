import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { TerminalHttpLinkActionDestinations } from './terminal-url-link-hit-testing'
import { translate } from '@/i18n/i18n'

export function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Mac')
}

function terminalLinkActionHintPrefix(showActions: boolean): string {
  return showActions
    ? translate(
        'auto.components.terminal.pane.terminal.link.open.hints.click.for.actions',
        '单击查看操作，'
      )
    : ''
}

export function getTerminalFileOpenHint(showActions = true): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  return isMacPlatform()
    ? `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.mac.open.file', '⌘+点击打开，或 ⇧⌘+点击用默认应用打开')}`
    : `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.windows.open.file', 'Ctrl+点击打开，或 Shift+Ctrl+点击用默认应用打开')}`
}

export function getTerminalOrcaFileOpenHint(showActions = true): string {
  const prefix = showActions
    ? translate(
        'auto.components.terminal.pane.terminal.link.open.hints.click.for.actions.or',
        '单击查看操作或 '
      )
    : ''
  return isMacPlatform()
    ? `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.mac.open.in.orca', '⌘+点击在 Orca 中打开')}`
    : `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.windows.open.in.orca', 'Ctrl+点击在 Orca 中打开')}`
}

// Why: local HTML paths keep Shift+modifier as the system-browser shortcut.
export function getTerminalHtmlFileOpenHint(showActions = true): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  return isMacPlatform()
    ? `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.mac.open.html', '⌘+点击打开，或 ⇧⌘+点击用默认浏览器打开')}`
    : `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.windows.open.html', 'Ctrl+点击打开，或 Shift+Ctrl+点击用默认浏览器打开')}`
}

export type TerminalUrlOpenHintOptions = {
  openLinksInApp?: boolean
  modifierInverts?: boolean
  showActions?: boolean
}

export function terminalHttpLinkActionDestinationsFor(
  settings: { openLinksInApp?: boolean } | null | undefined,
  sourceOwner: HttpLinkSourceOwner,
  canOpenRuntimeBrowser: boolean
): TerminalHttpLinkActionDestinations {
  const canOpenInOrca =
    sourceOwner.kind === 'local' || (sourceOwner.kind === 'runtime' && canOpenRuntimeBrowser)
  if (!canOpenInOrca) {
    return { primary: 'system' }
  }
  return settings?.openLinksInApp === true
    ? { primary: 'orca', alternate: 'system' }
    : { primary: 'system', alternate: 'orca' }
}

// Why: only a capability-verified runtime can advertise the in-app destination.
export function terminalUrlOpenHintOptionsFor(
  settings:
    | {
        openLinksInApp?: boolean
        openLinksInAppModifierInverts?: boolean
        activeRuntimeEnvironmentId?: string | null
      }
    | null
    | undefined,
  sourceOwner?: HttpLinkSourceOwner,
  canOpenRuntimeBrowser = false
): TerminalUrlOpenHintOptions {
  const sourceCanOpenInOrca = sourceOwner
    ? sourceOwner.kind === 'local' || (sourceOwner.kind === 'runtime' && canOpenRuntimeBrowser)
    : !settings?.activeRuntimeEnvironmentId?.trim()
  return {
    openLinksInApp: settings?.openLinksInApp === true,
    modifierInverts: settings?.openLinksInAppModifierInverts === true && sourceCanOpenInOrca
  }
}

// Why: with modifierInverts on, Shift no longer always means "system browser" —
// it means "the other one" — so the hint has to name the actual destination.
export function getTerminalUrlOpenHint(options: TerminalUrlOpenHintOptions = {}): string {
  const invertsToOrca = options.modifierInverts === true && options.openLinksInApp !== true
  const prefix = terminalLinkActionHintPrefix(options.showActions !== false)
  if (invertsToOrca) {
    return isMacPlatform()
      ? `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.mac.open.url.orca', '⌘+点击打开，或 ⇧⌘+点击在 Orca 中打开')}`
      : `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.windows.open.url.orca', 'Ctrl+点击打开，或 Shift+Ctrl+点击在 Orca 中打开')}`
  }
  return isMacPlatform()
    ? `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.mac.open.url.system', '⌘+点击打开，或 ⇧⌘+点击用系统浏览器打开')}`
    : `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.windows.open.url.system', 'Ctrl+点击打开，或 Shift+Ctrl+点击用系统浏览器打开')}`
}

export function getTerminalUrlSystemBrowserHint(): string {
  return isMacPlatform()
    ? translate(
        'auto.components.terminal.pane.terminal.link.open.hints.mac.system.browser',
        '⇧⌘+点击用系统浏览器打开'
      )
    : translate(
        'auto.components.terminal.pane.terminal.link.open.hints.windows.system.browser',
        'Shift+Ctrl+点击用系统浏览器打开'
      )
}

// Why: the mirror of the system-browser hint for surfaces where inverting sends the
// modifier the other way; a plain click there already opens the system browser.
export function getTerminalUrlOrcaBrowserHint(): string {
  return isMacPlatform()
    ? translate(
        'auto.components.terminal.pane.terminal.link.open.hints.mac.orca.browser',
        '⇧⌘+点击在 Orca 中打开'
      )
    : translate(
        'auto.components.terminal.pane.terminal.link.open.hints.windows.orca.browser',
        'Shift+Ctrl+点击在 Orca 中打开'
      )
}

export function getTerminalWorktreePathOpenHint(
  canOpenWithSystemDefault: boolean,
  showActions = true
): string {
  const prefix = terminalLinkActionHintPrefix(showActions)
  if (!canOpenWithSystemDefault) {
    const directPrefix = showActions
      ? translate(
          'auto.components.terminal.pane.terminal.link.open.hints.click.for.actions.or',
          '单击查看操作或 '
        )
      : ''
    return isMacPlatform()
      ? `${directPrefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.mac.switch.workspace', '⌘+点击切换工作区')}`
      : `${directPrefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.windows.switch.workspace', 'Ctrl+点击切换工作区')}`
  }

  return isMacPlatform()
    ? `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.mac.worktree.finder', '⌘+点击切换工作区，或 ⇧⌘+点击在访达中打开')}`
    : `${prefix}${translate('auto.components.terminal.pane.terminal.link.open.hints.windows.worktree.folder', 'Ctrl+点击切换工作区，或 Shift+Ctrl+点击打开文件夹')}`
}
