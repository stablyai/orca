// Which pane shows which secret request: the pane running the asking terminal, else the active pane of
// a visible tab on the same host. One card per pane; the rest count as "N more requests".
import type { SecretRequestEntry } from './secret-request-store'

export type SecretRequestPaneSlot = {
  paneKey: string
  environmentId: string
  /** The remote terminal handle this pane runs, when known. */
  handle: string | null
  /** The active pane of a visible tab: where requests without a matching pane land. */
  primary: boolean
}

export function routeSecretRequests(
  entries: readonly SecretRequestEntry[],
  slots: readonly SecretRequestPaneSlot[]
): Map<string, SecretRequestEntry[]> {
  const routed = new Map<string, SecretRequestEntry[]>()
  const byHandle = new Map<string, string>()
  for (const slot of slots) {
    if (slot.handle) {
      byHandle.set(`${slot.environmentId}\u0000${slot.handle}`, slot.paneKey)
    }
  }
  // Deterministic fallback when several visible tabs share a host: the lowest pane key.
  const primaryByEnvironment = new Map<string, string>()
  for (const slot of slots) {
    const current = primaryByEnvironment.get(slot.environmentId)
    if (slot.primary && (current === undefined || slot.paneKey < current)) {
      primaryByEnvironment.set(slot.environmentId, slot.paneKey)
    }
  }
  for (const entry of entries) {
    const handle = entry.event.terminalHandle
    const paneKey =
      (handle ? byHandle.get(`${entry.environmentId}\u0000${handle}`) : undefined) ??
      primaryByEnvironment.get(entry.environmentId)
    if (!paneKey) {
      continue
    }
    const list = routed.get(paneKey)
    if (list) {
      list.push(entry)
    } else {
      routed.set(paneKey, [entry])
    }
  }
  return routed
}

const AGENT_DISPLAY_NAME: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  copilot: 'Copilot',
  pi: 'Pi',
  amp: 'Amp',
  droid: 'Droid',
  aider: 'Aider'
}

/** orcad names the agent by id; unknown ids still read as a name, never as markup. */
export function secretRequestAgentName(agent: string | null): string | null {
  if (!agent) {
    return null
  }
  const known = AGENT_DISPLAY_NAME[agent.toLowerCase()]
  if (known) {
    return known
  }
  const clean = agent.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 32)
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : null
}

/** Agents Orca can restart in place in a pane (with --resume where the CLI supports it). */
export function restartableSecretRequestAgent(agent: string | null): 'claude' | 'codex' | null {
  return agent === 'claude' || agent === 'codex' ? agent : null
}
