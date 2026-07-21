import type { AgentType } from './agent-status-types'

// Shared so the desktop renderer and the mobile app show the same agent name
// (e.g. native chat's empty state on both surfaces) from one source of truth.
const WELL_KNOWN_LABELS: Record<string, string> = {
  claude: 'Claude',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  amp: 'Amp',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  'mimo-code': 'MiMo Code',
  cursor: 'Cursor',
  aider: 'Aider',
  pi: 'Pi',
  omp: 'OMP',
  droid: 'Droid',
  'command-code': 'Command Code',
  grok: 'Grok',
  hermes: 'Hermes',
  devin: 'Devin',
  ante: 'Ante',
  kimi: 'Kimi'
}

export function formatAgentTypeLabel(agentType: AgentType | null | undefined): string {
  if (!agentType || agentType === 'unknown') {
    return 'Agent'
  }
  // Capitalize well-known names nicely; pass through custom names as-is
  return WELL_KNOWN_LABELS[agentType] ?? agentType
}
