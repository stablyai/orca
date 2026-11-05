import type * as React from 'react'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { GitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'

export type ComposerSourceContextModel = {
  setRepoId: (value: string) => void
  name: string
  setName: React.Dispatch<React.SetStateAction<string>>
  agentPrompt: string
  setAgentPrompt: React.Dispatch<React.SetStateAction<string>>
  note: string
  setNote: React.Dispatch<React.SetStateAction<string>>
  attachmentPaths: string[]
  setAttachmentPaths: React.Dispatch<React.SetStateAction<string[]>>
  normalizedInitialLinkedWorkItem: LinkedWorkItemSummary | null
  normalizedDraftLinkedWorkItem: LinkedWorkItemSummary | null
  draftLinkedTaskSourceContext: TaskSourceContext | null
  initialLinkedTaskSourceContext: TaskSourceContext | null
  initialLinkedWorkItemSeed: LinkedWorkItemSummary | null
  draftLinkedWorkItemSeed: LinkedWorkItemSummary | null
  linkedWorkItemSeed: LinkedWorkItemSummary | null
  linkedWorkItemSeedIdentity: GitHubWorkItemIdentity | null
  linkedWorkItem: LinkedWorkItemSummary | null
  setLinkedWorkItem: React.Dispatch<React.SetStateAction<LinkedWorkItemSummary | null>>
  initialLinearBranchName: string | undefined
  linkedTaskSourceContext: TaskSourceContext | null
  setLinkedTaskSourceContext: React.Dispatch<React.SetStateAction<TaskSourceContext | null>>
  derivedGitHubTaskSourceContext: TaskSourceContext | null
  taskSourceContext: TaskSourceContext | null
  selectedRepoGitHubSourceContext: TaskSourceContext | null
  smartNameJiraSourceContext: TaskSourceContext | null
}
