import { getAgentLabel, titleHasAgentName } from './agent-detection'
import type { TuiAgent } from './types'

// Maps getAgentLabel()'s product labels to TuiAgent ids — the fallback for
// agents whose foreground PROCESS name isn't self-identifying (Claude Code runs
// as `node`, but its "✳ Claude Code" title resolves here). Agents whose process
// name already matches (codex, etc.) never reach this path.
const TITLE_LABEL_TO_AGENT: Partial<Record<string, TuiAgent>> = {
  'Claude Code': 'claude',
  OpenClaude: 'openclaude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  'GitHub Copilot': 'copilot',
  Grok: 'grok',
  Devin: 'devin',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  'MiMo Code': 'mimo-code',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  Pi: 'pi',
  OMP: 'omp'
}

function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) {
      return true
    }
  }
  return false
}

function hasGenericClaudeStatusPrefix(title: string): boolean {
  return (
    containsBrailleSpinner(title) ||
    title.startsWith('✳ ') ||
    title === '✳' ||
    title.startsWith('. ') ||
    title.startsWith('* ')
  )
}

function isGenericClaudeStatusClaim(title: string, titleAgent: TuiAgent | null): boolean {
  return (
    titleAgent === 'claude' &&
    hasGenericClaudeStatusPrefix(title) &&
    !titleHasAgentName(title, 'claude')
  )
}

function resolveTerminalTitleAgentType(title: string): TuiAgent | null {
  const label = getAgentLabel(title)
  return label ? (TITLE_LABEL_TO_AGENT[label] ?? null) : null
}

/**
 * Resolve a terminal title's agent identity, but treat Claude's bare status
 * prefixes (spinner / "✳" / ". " / "* ") as activity-only. They are evidence
 * that something is running, not proof the agent is Claude — so a task or
 * worktree title cannot become Claude without an explicit "Claude Code" name.
 */
export function resolveExplicitTerminalTitleAgentType(title: string): TuiAgent | null {
  const titleAgent = resolveTerminalTitleAgentType(title)
  if (isGenericClaudeStatusClaim(title, titleAgent)) {
    return null
  }
  return titleAgent
}
