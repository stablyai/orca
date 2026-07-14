const passwordsByTabId = new Map<string, string>()

export function getDatabaseTabPassword(tabId: string): string {
  return passwordsByTabId.get(tabId) ?? ''
}

export function setDatabaseTabPassword(tabId: string, password: string): void {
  if (password) {
    passwordsByTabId.set(tabId, password)
    return
  }
  passwordsByTabId.delete(tabId)
}

export function clearDatabaseTabPassword(tabId: string): void {
  passwordsByTabId.delete(tabId)
}
