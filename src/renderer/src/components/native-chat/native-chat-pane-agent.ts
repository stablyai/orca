import type { AgentType } from '../../../../shared/agent-status-types'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

export type NativeChatPaneAgentInput = {
  hookAgent?: AgentType | null
  foreground?: PaneForegroundAgentEntry
  paneLaunchAgent?: AgentType | null
  fallbackAgent?: AgentType | null
}

/** Resolve pane-local runtime evidence before the legacy single-pane fallback. */
export function resolveNativeChatPaneAgent(input: NativeChatPaneAgentInput): AgentType | null {
  if (input.hookAgent) {
    return input.hookAgent
  }
  if (input.foreground?.shellForeground || input.foreground?.routingRevoked) {
    return null
  }
  return input.foreground?.agent ?? input.paneLaunchAgent ?? input.fallbackAgent ?? null
}

type LaunchConfigState = Record<string, { identity: { agentType?: AgentType | null } } | undefined>
type ForegroundState = Record<string, PaneForegroundAgentEntry | undefined>

export type NativeChatPaneEvidence = {
  paneLaunchAgent?: AgentType | null
  foreground?: PaneForegroundAgentEntry
}
export type NativeChatPaneEvidenceByLeaf = Readonly<Record<string, NativeChatPaneEvidence>>

const EMPTY_EVIDENCE_BY_LEAF: NativeChatPaneEvidenceByLeaf = Object.freeze({})

function recordsEqual(
  previous: NativeChatPaneEvidenceByLeaf | undefined,
  next: Record<string, NativeChatPaneEvidence>
): boolean {
  if (!previous) {
    return false
  }
  const nextKeys = Object.keys(next)
  if (Object.keys(previous).length !== nextKeys.length) {
    return false
  }
  return nextKeys.every((leafId) => {
    const prior = previous[leafId]
    const current = next[leafId]
    return (
      prior?.paneLaunchAgent === current.paneLaunchAgent && prior?.foreground === current.foreground
    )
  })
}

export function createTerminalTabNativeChatPaneEvidenceSelector(): (
  launchConfigs: LaunchConfigState,
  foregroundAgents: ForegroundState,
  tabId: string
) => NativeChatPaneEvidenceByLeaf {
  let cachedLaunchConfigs: LaunchConfigState | null = null
  let cachedForegroundAgents: ForegroundState | null = null
  let cachedByTabId = new Map<string, NativeChatPaneEvidenceByLeaf>()

  return (launchConfigs, foregroundAgents, tabId) => {
    if (launchConfigs !== cachedLaunchConfigs || foregroundAgents !== cachedForegroundAgents) {
      const previousByTabId = cachedByTabId
      const nextByTabId = new Map<string, Record<string, NativeChatPaneEvidence>>()
      const write = (paneKey: string, evidence: NativeChatPaneEvidence): void => {
        const separator = paneKey.indexOf(':')
        if (separator <= 0) {
          return
        }
        const entryTabId = paneKey.slice(0, separator)
        const leafId = paneKey.slice(separator + 1)
        const byLeaf = nextByTabId.get(entryTabId)
        if (byLeaf) {
          byLeaf[leafId] = { ...byLeaf[leafId], ...evidence }
        } else {
          nextByTabId.set(entryTabId, { [leafId]: evidence })
        }
      }

      for (const [paneKey, entry] of Object.entries(launchConfigs)) {
        if (entry?.identity.agentType) {
          write(paneKey, { paneLaunchAgent: entry.identity.agentType })
        }
      }
      for (const [paneKey, foreground] of Object.entries(foregroundAgents)) {
        if (foreground) {
          write(paneKey, { foreground })
        }
      }

      const stabilized = new Map<string, NativeChatPaneEvidenceByLeaf>()
      for (const [entryTabId, byLeaf] of nextByTabId) {
        const previous = previousByTabId.get(entryTabId)
        stabilized.set(entryTabId, recordsEqual(previous, byLeaf) ? previous! : byLeaf)
      }
      cachedByTabId = stabilized
      cachedLaunchConfigs = launchConfigs
      cachedForegroundAgents = foregroundAgents
    }
    return cachedByTabId.get(tabId) ?? EMPTY_EVIDENCE_BY_LEAF
  }
}

export const selectTerminalTabNativeChatPaneEvidence =
  createTerminalTabNativeChatPaneEvidenceSelector()
