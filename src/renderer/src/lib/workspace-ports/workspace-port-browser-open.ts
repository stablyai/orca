import { translate } from '@/i18n/i18n'

export function shouldOpenWorkspacePortInOrcaBrowser(
  settings: { openLinksInApp?: boolean } | null | undefined
): boolean {
  return settings?.openLinksInApp === true
}

function isMacShortcutPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function getPortSystemBrowserHint(isMac: boolean = isMacShortcutPlatform()): string {
  return translate(
    'auto.lib.workspacePortBrowserOpen.systemBrowserHint',
    '{{shortcut}}+click to open in the system browser',
    { shortcut: isMac ? '⇧⌘' : 'Shift+Ctrl' }
  )
}

export function getPortOpenBrowserTooltipLabel(openLabel: string, isMac?: boolean): string {
  return translate('auto.lib.workspacePortBrowserOpen.tooltip', '{{label}}. {{hint}}', {
    label: openLabel,
    hint: getPortSystemBrowserHint(isMac)
  })
}

type PortOpenClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export function resolvePortOpenInOrcaBrowser({
  settings,
  event,
  isMac
}: {
  settings: { openLinksInApp?: boolean } | null | undefined
  event?: PortOpenClickEvent | null
  isMac: boolean
}): boolean {
  // Shift+Cmd/Ctrl forces external browser; keyboard/context-menu opens without pointer events retain saved settings.
  if (event?.shiftKey && (isMac ? event.metaKey : event.ctrlKey)) {
    return false
  }
  return shouldOpenWorkspacePortInOrcaBrowser(settings)
}
