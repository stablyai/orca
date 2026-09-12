import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import {
  canUseIssueCommandForLinkedItemProvider,
  renderIssueCommandTemplate
} from '@/lib/new-workspace'
import type { FolderWorkspaceLinkedTask } from '../../../shared/folder-workspace-types'

type ComposerIssueCommandInput = {
  enabled: boolean
  provider: FolderWorkspaceLinkedTask['provider'] | null
  issueNumber: number | null
  template: string
  artifactUrl: string | null
}

export function shouldPrepareComposerIssueCommand(input: ComposerIssueCommandInput): boolean {
  return (
    input.enabled &&
    canUseIssueCommandForLinkedItemProvider(input.provider) &&
    input.issueNumber !== null &&
    input.template.trim().length > 0
  )
}

export function buildTrustedComposerIssueCommand(
  input: ComposerIssueCommandInput & { trustDecision: 'run' | 'skip' }
): WorktreeCreationRequest['issueCommand'] | undefined {
  if (input.trustDecision !== 'run' || !shouldPrepareComposerIssueCommand(input)) {
    return undefined
  }
  return {
    command: renderIssueCommandTemplate(input.template.trim(), {
      issueNumber: input.issueNumber,
      artifactUrl: input.artifactUrl
    })
  }
}
