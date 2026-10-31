import type { TuiAgent } from './tui-agent'

// Identities agents write as the author or in a Co-authored-by trailer.
const AGENT_COMMIT_IDENTITIES: readonly { agent: TuiAgent; matches: (email: string) => boolean }[] =
  [
    { agent: 'claude', matches: (email) => email === 'noreply@anthropic.com' },
    { agent: 'cursor', matches: (email) => email === 'cursoragent@cursor.com' },
    {
      agent: 'copilot',
      matches: (email) => /^\d+\+copilot@users\.noreply\.github\.com$/.test(email)
    },
    { agent: 'aider', matches: (email) => email === 'noreply@aider.chat' },
    { agent: 'droid', matches: (email) => email.includes('+factory-droid[bot]@') },
    { agent: 'devin', matches: (email) => email.includes('+devin-ai-integration[bot]@') }
  ]

const CO_AUTHOR_TRAILER = /^co-authored-by:[^<\n]*<([^>\n]+)>\s*$/gim

function agentForEmail(email: string): TuiAgent | null {
  const normalized = email.trim().toLowerCase()
  return AGENT_COMMIT_IDENTITIES.find((identity) => identity.matches(normalized))?.agent ?? null
}

// The agent when it authored the commit itself, rather than co-authoring a person's commit.
export function detectCommitAuthorAgent(authorEmail: string | undefined): TuiAgent | null {
  return authorEmail ? agentForEmail(authorEmail) : null
}

export function detectCommitAgent(commit: {
  authorEmail?: string
  message?: string
}): TuiAgent | null {
  const authorAgent = detectCommitAuthorAgent(commit.authorEmail)
  if (authorAgent) {
    return authorAgent
  }
  for (const match of (commit.message ?? '').matchAll(CO_AUTHOR_TRAILER)) {
    const agent = agentForEmail(match[1]!)
    if (agent) {
      return agent
    }
  }
  return null
}

// The message without the trailers that credit `agent`, which the author line already names.
export function stripAgentCoAuthorTrailers(message: string, agent: TuiAgent): string {
  return message
    .replace(CO_AUTHOR_TRAILER, (line, email: string) =>
      agentForEmail(email) === agent ? '' : line
    )
    .trimEnd()
}
