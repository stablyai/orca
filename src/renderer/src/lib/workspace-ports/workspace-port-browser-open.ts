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
  const systemBrowser = translate(
    'auto.components.settings.browser.use.search.63a66da648',
    'system browser'
  )
  if (systemBrowser === '系统浏览器') {
    return isMac ? '⇧⌘+点击用系统浏览器打开' : 'Shift+Ctrl+点击用系统浏览器打开'
  }
  return isMac ? `⇧⌘+click for ${systemBrowser}` : `Shift+Ctrl+click for ${systemBrowser}`
}

export function getPortOpenBrowserTooltipLabel(openLabel: string, isMac?: boolean): string {
  const hint = getPortSystemBrowserHint(isMac)
  const separator = /[\u3400-\u9fff]/u.test(`${openLabel}${hint}`) ? '，' : '. '
  return `${openLabel}${separator}${hint}`
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
