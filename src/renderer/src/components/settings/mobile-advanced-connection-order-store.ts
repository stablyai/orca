const MOBILE_ADVANCED_CONNECTION_ORDER_STORAGE_KEY = 'orca:mobile-advanced-connection-order-enabled'

export function loadMobileAdvancedConnectionOrderEnabled(): boolean {
  try {
    return window.localStorage.getItem(MOBILE_ADVANCED_CONNECTION_ORDER_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveMobileAdvancedConnectionOrderEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(MOBILE_ADVANCED_CONNECTION_ORDER_STORAGE_KEY, String(enabled))
  } catch {
    // Persistence is optional; the current pairing flow still honors the choice.
  }
}
