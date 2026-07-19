import type { StatusPillSummary } from '../../shared/status-pill-preload-api'

export type Tone = 'idle' | 'working' | 'blocked' | 'waiting' | 'done'

export function pickTone(summary: StatusPillSummary): Tone {
  if (summary.blocked > 0) {
    return 'blocked'
  }
  if (summary.waiting > 0) {
    return 'waiting'
  }
  if (summary.working > 0) {
    return 'working'
  }
  if (summary.recentDone > 0) {
    return 'done'
  }
  return 'idle'
}

export function pickInitials(agentType: string): string {
  const lower = agentType.toLowerCase()
  const map: Record<string, string> = {
    claude: 'Cl',
    openclaude: 'Cl',
    codex: 'Co',
    gemini: 'Ge',
    copilot: 'Cp',
    cursor: 'Cu',
    opencode: 'Oc',
    aider: 'Ai',
    droid: 'Dr',
    amp: 'Am',
    grok: 'Gr'
  }
  return map[lower] ?? agentType.slice(0, 2).toUpperCase()
}

export function pickAvatarClass(agentType: string): string {
  const lower = agentType.toLowerCase()
  const map: Record<string, string> = {
    claude: 'av-claude',
    openclaude: 'av-claude',
    codex: 'av-codex',
    gemini: 'av-gemini',
    cursor: 'av-cursor'
  }
  return map[lower] ?? 'av-default'
}

export function formatAgentLabel(agentType: string): string {
  const lower = agentType.toLowerCase()
  const map: Record<string, string> = {
    claude: 'Claude',
    openclaude: 'Claude',
    codex: 'Codex',
    gemini: 'Gemini',
    copilot: 'Copilot',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    aider: 'Aider',
    droid: 'Droid',
    amp: 'Amp',
    grok: 'Grok'
  }
  return map[lower] ?? agentType
}

export function formatRelativeTime(receivedAt: number): string {
  if (!receivedAt) {
    return ''
  }
  const seconds = Math.max(0, Math.floor((Date.now() - receivedAt) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function buildPanelTitle(summary: StatusPillSummary): string {
  const parts: string[] = []
  if (summary.working > 0) {
    parts.push(`${summary.working} working`)
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked} blocked`)
  }
  if (summary.waiting > 0) {
    parts.push(`${summary.waiting} waiting`)
  }
  if (parts.length === 0) {
    return summary.recentDone > 0 ? `${summary.recentDone} recently done` : 'No active agents'
  }
  return parts.join(' · ')
}
