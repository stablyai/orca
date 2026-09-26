import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import {
  canUseIssueCommandForLinkedItemProvider,
  renderIssueCommandTemplate
} from '@/lib/new-workspace'
import {
  DEFAULT_REPO_COMMAND_TEMPLATE,
  type RepoCommandKind
} from '../../../shared/repo-command-kind'
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

// Why: an untouched note means the template *is* the agent prompt, so callers suppress the shell split.
export function resolveLinkedOnlyTemplatePrompt(input: {
  trustDecision: 'run' | 'skip'
  note: string
  kind: RepoCommandKind
  number: number | null
  artifactUrl: string | null
  template: string
}): string {
  const template = input.template.trim()
  // Why: the trust gate guards repository text only; an absent template leaves the built-in default.
  if (
    (template && input.trustDecision !== 'run') ||
    input.note.trim() ||
    input.artifactUrl === null
  ) {
    return ''
  }
  // Why: {{issue}} is meaningless without a number; review templates lean on {{artifact_url}}.
  if (input.kind === 'issue' && input.number === null) {
    return ''
  }
  return renderIssueCommandTemplate(template || DEFAULT_REPO_COMMAND_TEMPLATE[input.kind], {
    issueNumber: input.number,
    artifactUrl: input.artifactUrl
  })
}
