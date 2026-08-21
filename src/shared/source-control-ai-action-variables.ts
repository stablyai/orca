import type { SourceControlActionId } from './source-control-ai-actions'

/**
 * Registering a variable a hover card cannot describe is a compile error: the
 * element type is keyed off `SOURCE_CONTROL_ACTION_VARIABLE_INFO`, so chips can
 * never index a missing entry.
 */
export const SOURCE_CONTROL_ACTION_VARIABLES: Record<
  SourceControlActionId,
  SourceControlActionVariable[]
> = {
  commitMessage: ['basePrompt', 'branch', 'stagedFiles', 'stagedPatch', 'linkedIssue'],
  pullRequest: [
    'basePrompt',
    'branch',
    'baseBranch',
    'currentTitle',
    'currentBody',
    'commitSummary',
    'changedFiles',
    'patch',
    'linkedIssue'
  ],
  branchName: ['basePrompt', 'firstPrompt', 'assistantMessage'],
  fixCommitFailure: ['basePrompt'],
  fixPushFailure: ['basePrompt'],
  fixChecks: ['basePrompt'],
  resolveConflicts: ['basePrompt'],
  resolveComments: ['basePrompt']
}

export type SourceControlActionVariableInfo = {
  description: string
  example: string
}

export const SOURCE_CONTROL_ACTION_VARIABLE_INFO = {
  basePrompt: {
    description:
      'Orca’s built-in prompt for this action, including the context Orca knows how to gather safely.',
    example:
      'Commit messages include staged diff guidance; PR details include branch comparison guidance; fix actions include the failure summary.'
  },
  branch: {
    description: 'The current source-control branch name.',
    example: 'feature/source-control-ai-recipes'
  },
  stagedFiles: {
    description: 'A newline-separated list of staged files for commit-message generation.',
    example: 'M src/shared/source-control-ai.ts\nA src/shared/source-control-ai-actions.ts'
  },
  stagedPatch: {
    description: 'The staged git patch used for commit-message generation.',
    example: 'diff --git a/src/app.ts b/src/app.ts\n+addActionRecipeDefaults()'
  },
  baseBranch: {
    description: 'The target branch selected in the Create PR composer.',
    example: 'main'
  },
  currentTitle: {
    description: 'The PR title currently typed in the composer before generation starts.',
    example: 'Improve Source Control AI customization'
  },
  currentBody: {
    description: 'The PR description currently typed in the composer before generation starts.',
    example: 'Adds configurable agents and command templates for Source Control actions.'
  },
  commitSummary: {
    description: 'A newline-separated list of commits on the branch compared to the base.',
    example: 'a1b2c3d Add action recipe defaults\nd4e5f6a Render command templates'
  },
  changedFiles: {
    description: 'A summary of files changed between the branch and the base branch.',
    example:
      'src/shared/source-control-ai-actions.ts | 24 +++++\nsrc/main/text-generation.ts | 8 +-'
  },
  patch: {
    description: 'The branch diff against the base branch used for PR-details generation.',
    example: 'diff --git a/src/app.ts b/src/app.ts\n+renderSourceControlActionCommandTemplate()'
  },
  firstPrompt: {
    description: 'The first user request that created the Orca workspace.',
    example: 'Fix CI and commit the result'
  },
  assistantMessage: {
    description: 'The initial agent response, when Orca has one available.',
    example: 'I will inspect the failing check, patch the issue, and run tests.'
  },
  linkedIssue: {
    description:
      'The GitHub issue number linked to this workspace. Empty when no GitHub issue is linked (including GitLab-linked workspaces). Prefer instructional templates: a bare "Fixes #{linkedIssue}" becomes "Fixes #" when unlinked.',
    example: '123'
  }
} satisfies Record<string, SourceControlActionVariableInfo>

export type SourceControlActionVariable = keyof typeof SOURCE_CONTROL_ACTION_VARIABLE_INFO

/**
 * Issue numbers are positive integers on every supported provider, so anything
 * else (negative, zero, fractional, non-finite) is corrupt metadata rather than
 * a renderable issue reference — `Fixes #-7` is worse output than `Fixes #`.
 * The safe-integer bound also keeps the rendering in decimal notation: `String`
 * switches to exponent form (`1e+21`) above it.
 */
export function isLinkedIssueNumber(linkedIssue: unknown): linkedIssue is number {
  return typeof linkedIssue === 'number' && Number.isSafeInteger(linkedIssue) && linkedIssue > 0
}

/**
 * Render the workspace-linked GitHub issue for template substitution. Anything
 * that is not a positive integer becomes `''` so the token expands to nothing
 * instead of leaking into the prompt.
 */
export function formatLinkedIssueTemplateValue(linkedIssue: number | null | undefined): string {
  return isLinkedIssueNumber(linkedIssue) ? String(linkedIssue) : ''
}

/**
 * Attach a resolved issue number to a draft context. Returns the context untouched
 * when nothing resolves, so unlinked workspaces keep their existing context shape.
 * The `linkedIssue`-bearing constraint keeps the attach off contexts that do not
 * declare the field (branch-name generation), where it would be silently unread.
 */
export function withLinkedIssueDraftContext<T extends { linkedIssue?: number | null }>(
  context: T,
  linkedIssue: number | null | undefined
): T {
  return isLinkedIssueNumber(linkedIssue) ? { ...context, linkedIssue } : context
}
