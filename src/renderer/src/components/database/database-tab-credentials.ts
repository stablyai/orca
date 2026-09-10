const passwordsByTabId = new Map<string, { password: string; owner: string | undefined }>()

export function getDatabaseTabPassword(tabId: string, owner?: string): string {
  const entry = passwordsByTabId.get(tabId)
  return entry?.owner === owner ? (entry?.password ?? '') : ''
}

export function setDatabaseTabPassword(tabId: string, password: string, owner?: string): void {
  if (password) {
    passwordsByTabId.set(tabId, { password, owner })
    return
  }
  passwordsByTabId.delete(tabId)
}

export function clearDatabaseTabPassword(tabId: string): void {
  passwordsByTabId.delete(tabId)
}
