import type { GlobalSettings } from '../../../../../shared/global-settings-types'

export function isNativeTerminalRequested(settings: GlobalSettings | null | undefined): boolean {
  return (
    settings?.experimentalNativeTerminal === true &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Mac')
  )
}
