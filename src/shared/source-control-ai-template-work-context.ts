import type { SourceControlActionVariable } from './source-control-ai-action-variables'
import {
  renderSourceControlActionCommandTemplate,
  type SourceControlTextActionId
} from './source-control-ai-actions'

// Why: a template that references none of these renders verbatim, so the agent
// describes the template text instead of the user's work (#20112). Only variables
// that are always populated count; `assistantMessage` can be empty.
const WORK_CONTEXT_VARIABLES = {
  commitMessage: ['basePrompt', 'stagedFiles', 'stagedPatch'],
  pullRequest: ['basePrompt', 'commitSummary', 'changedFiles', 'patch'],
  branchName: ['basePrompt', 'firstPrompt']
} as const satisfies Record<SourceControlTextActionId, readonly SourceControlActionVariable[]>

const WORK_CONTEXT_NOUNS: Record<SourceControlTextActionId, string> = {
  commitMessage: 'staged changes',
  pullRequest: 'branch changes',
  branchName: 'workspace task'
}

const MARKER = '\u0000'

export function findMissingWorkContextError(
  actionId: SourceControlTextActionId,
  template: string | undefined
): string | null {
  if (template === undefined) {
    return null
  }
  const variables = WORK_CONTEXT_VARIABLES[actionId]
  // Render through the real substitution so every accepted placeholder spelling counts.
  const rendered = renderSourceControlActionCommandTemplate(
    template,
    Object.fromEntries(variables.map((name) => [name, MARKER]))
  )
  if (rendered.includes(MARKER)) {
    return null
  }
  const names = variables.map((name) => `{${name}}`)
  return `Command template must include ${names.slice(0, -1).join(', ')} or ${names.at(-1)}; otherwise the agent never sees the ${WORK_CONTEXT_NOUNS[actionId]}.`
}
