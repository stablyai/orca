export type HistoryResumeAccount = {
  id: string | null
  label: string
  available: boolean
}

export type HistoryContinuation = {
  provider: 'codex' | 'claude'
  sessionId: string
  filePath: string
  home: string
  rootSessionId: string
  parentSessionId?: string
  accountId?: string | null
  openedAt: number
}

export type HistoryResumePlan = {
  token: string
  accounts: HistoryResumeAccount[]
  lastAccountId?: string | null
  workspaceAccountId?: string | null
  needsChoice: boolean
}
