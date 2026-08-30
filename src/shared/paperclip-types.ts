export type PaperclipConnectionIdentity = {
  id: string
  origin: string
  companyId: string
  projectId: string
}

export type PaperclipConnectionSummary = PaperclipConnectionIdentity & {
  companyName: string
  projectName: string
}

export type PaperclipConnectionStatus = {
  connected: boolean
  connection: PaperclipConnectionSummary | null
}

export type PaperclipConnectArgs = {
  origin: string
  companyId: string
  projectId: string
}

export type PaperclipCompany = { id: string; name: string }
export type PaperclipProject = { id: string; companyId: string; name: string }

export type PaperclipIssue = {
  id: string
  identifier: string
  companyId: string
  projectId: string | null
  title: string
  description: string | null
  status: string
  priority: string | null
  checkoutRunId: string | null
  executionRunId: string | null
  executionLockedAt: string | null
}

export type PaperclipLaunchAdmission =
  | { allowed: false; reason: 'active_run' | 'unknown_run_state' | 'claim_markers' }
  | { allowed: true; requiresNonExclusiveConfirmation: true }

export type PaperclipLaunchAdmissionRequest = {
  issueId: string
  connectionId: string
  companyId: string
  projectId: string
}
