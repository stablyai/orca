// Which pane shows which secret request. One card per pane; the rest count as "N more requests".
import type { SecretRequestEntry } from './secret-request-store'

export type SecretRequestPaneSlot = {
  paneKey: string
  environmentId: string
  /** The remote terminal handle this pane runs, when known. */
  handle: string | null
  /** The pane's tab is the one showing. */
  visible: boolean
  /** The active pane of a showing tab: where requests without a showing asking pane land. */
  primary: boolean
}

type RoutedSecretRequest = {
  entry: SecretRequestEntry
  /** Shown on the pane running the asking terminal, so "Restart {{agent}}" restarts the right one. */
  onAskingPane: boolean
}

function handleKey(environmentId: string, handle: string): string {
  return JSON.stringify([environmentId, handle])
}

/**
 * The asking terminal's pane when its tab is showing; else the active pane of a showing tab on the
 * same host; else the asking pane even though hidden (it shows when that tab is opened).
 */
export function routeSecretRequests(
  entries: readonly SecretRequestEntry[],
  slots: readonly SecretRequestPaneSlot[]
): Map<string, RoutedSecretRequest[]> {
  const routed = new Map<string, RoutedSecretRequest[]>()
  const byHandle = new Map<string, SecretRequestPaneSlot>()
  for (const slot of slots) {
    if (slot.handle) {
      byHandle.set(handleKey(slot.environmentId, slot.handle), slot)
    }
  }
  // Deterministic when several showing tabs share a host: the lowest pane key.
  const primaryByEnvironment = new Map<string, string>()
  for (const slot of slots) {
    const current = primaryByEnvironment.get(slot.environmentId)
    if (slot.primary && slot.visible && (current === undefined || slot.paneKey < current)) {
      primaryByEnvironment.set(slot.environmentId, slot.paneKey)
    }
  }
  for (const entry of entries) {
    const handle = entry.event.terminalHandle
    const asking = handle ? byHandle.get(handleKey(entry.environmentId, handle)) : undefined
    const primary = primaryByEnvironment.get(entry.environmentId)
    const paneKey = asking?.visible ? asking.paneKey : (primary ?? asking?.paneKey)
    if (!paneKey) {
      continue
    }
    const item = { entry, onAskingPane: asking?.paneKey === paneKey }
    const list = routed.get(paneKey)
    if (list) {
      list.push(item)
    } else {
      routed.set(paneKey, [item])
    }
  }
  return routed
}

/** Pending requests no showing pane displays (the person is looking at another workspace). */
export function unseenSecretRequests(
  entries: readonly SecretRequestEntry[],
  slots: readonly SecretRequestPaneSlot[]
): SecretRequestEntry[] {
  const routed = routeSecretRequests(entries, slots)
  const visibleKeys = new Set(slots.filter((slot) => slot.visible).map((slot) => slot.paneKey))
  const seen = new Set<SecretRequestEntry>()
  for (const [paneKey, items] of routed) {
    if (visibleKeys.has(paneKey)) {
      for (const item of items) {
        seen.add(item.entry)
      }
    }
  }
  return entries.filter(
    (entry) => !seen.has(entry) && entry.local === null && entry.settled === null
  )
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
