/** One existing task-list row the agent checks for duplicates. */
export type IssueDraftAgentPromptItem = {
  kind: 'issue' | 'pr'
  number: number
  title: string
  state: string
  url: string
  labels: readonly string[]
}

export type IssueDraftAgentPromptInput = {
  /** Repository the issues go to, e.g. `owner/repo`. */
  repositoryLabel: string
  /** Search query the list was filtered with, if any. */
  query: string | null
  existingItems: readonly IssueDraftAgentPromptItem[]
}

/** Rows beyond this stay out of the prompt; the agent can search more with `gh`. */
export const ISSUE_DRAFT_AGENT_PROMPT_ITEM_LIMIT = 50

function formatItem(item: IssueDraftAgentPromptItem): string {
  const kind = item.kind === 'pr' ? 'PR' : 'Issue'
  const labels = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : ''
  return `- ${kind} #${item.number} (${item.state}) ${item.title}${labels} — ${item.url}`
}

/** Opening message of the Tasks-page conversation that turns ideas into GitHub issues. */
export function buildIssueDraftAgentPrompt(input: IssueDraftAgentPromptInput): string {
  const shown = input.existingItems.slice(0, ISSUE_DRAFT_AGENT_PROMPT_ITEM_LIMIT)
  const omitted = input.existingItems.length - shown.length
  const lines = [
    `You are my issue-drafting assistant for ${input.repositoryLabel}, opened from the Orca task list. In this conversation I will describe things I want filed as GitHub issues.`,
    '',
    'For each request:',
    '1. Check for duplicates first: the items below, then `gh issue list --search` / `gh pr list --search`. If one already covers it, point me to it instead of drafting.',
    '2. Ask me about anything unclear, and read the code in this checkout when it helps make the issue concrete. Split the request into several issues only if it clearly covers separate work.',
    "3. Show the draft (title, body, and labels that exist in the repository) and revise it with me until I'm happy.",
    '4. File it with `gh issue create` only after I explicitly tell you to file that draft. Then reply with the issue URL.',
    'Do not edit files, comment, label, assign, or close anything on GitHub in this conversation.'
  ]
  lines.push(
    '',
    `Items currently shown in the task list${input.query ? ` (filter: ${input.query})` : ''}:`
  )
  lines.push(...(shown.length > 0 ? shown.map(formatItem) : ['- (none provided)']))
  if (omitted > 0) {
    lines.push(`- …and ${omitted} more not listed here`)
  }
  lines.push('', 'Reply in one short sentence that you are ready, and ask what I want to file.')
  return lines.join('\n')
}
