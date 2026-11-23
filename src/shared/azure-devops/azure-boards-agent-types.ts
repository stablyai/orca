import type { AzureDevOpsWorkItem } from './boards-types'

export const AZURE_BOARDS_AGENT_ACCESS_RUNTIME_CAPABILITY = 'azure-boards.agent-access.v1' as const
export const AZURE_BOARDS_AGENT_WRITE_RUNTIME_CAPABILITY = 'azure-boards.agent-write.v1' as const

/** What `orca azure-boards connection` reports for one repo; never carries a credential. */
export type AzureBoardsConnection = {
  authenticated: boolean
  account: string | null
  /** `azure-cli` when Orca signs in through `az`, `token` for a configured PAT or bearer. */
  credentialSource: 'azure-cli' | 'token' | null
  organization: string | null
  project: string
  repository: string
  webBaseUrl: string
}

export type AzureDevOpsWorkItemSearchPage = {
  items: AzureDevOpsWorkItem[]
  unhydratedItemCount: number
  /** The query returned at least this many ids, so the list may be cut short. */
  truncatedAtLimit?: number
}

export type AzureDevOpsWorkItemComment = {
  id: number
  author: string | null
  createdDate: string | null
  modifiedDate: string | null
  /** Azure DevOps stores comments as HTML; agents treat it as untrusted text. */
  textHtml: string
}
