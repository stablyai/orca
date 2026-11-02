import type { WorkspaceAttachment, Worktree } from './worktree/types'
import type { ExecutionHostId } from './execution-host'
import type { PtyLivenessVerdict } from './pty-liveness-verdict'

export type ReferenceWorkspace = Worktree & {
  kind: 'worktree' | 'folder'
  name: string
  repo: string
}

export type RuntimeReferenceEntry = WorkspaceAttachment & { key: string; selected: boolean }

export type RuntimeReferenceAgent = {
  linked: boolean
  liveness: PtyLivenessVerdict['status']
  terminal?: string
  mailbox?: string
  agent?: string
  paneKey?: string
  sessionId?: string
}

export type RuntimeReferenceFindParams = {
  query: string
  worktree?: string
  cwd?: string
  repo?: string
  includeArchived?: boolean
  limit?: number
}

export type RuntimeReferenceFindResult = {
  kind: 'reference_matches'
  query: string
  scope: { source: 'stored-metadata'; worktree?: string; repo?: string; includeArchived: boolean }
  truncated: boolean
  matches: {
    reference: WorkspaceAttachment & { key: string }
    workspace: {
      id: string
      name: string
      repo: string
      kind: 'worktree' | 'folder'
      archived: boolean
      hostId?: ExecutionHostId
    }
    agents: RuntimeReferenceAgent[]
  }[]
}

export type RuntimeReferenceListResult = {
  worktree: ReferenceWorkspace
  references: RuntimeReferenceEntry[]
}
