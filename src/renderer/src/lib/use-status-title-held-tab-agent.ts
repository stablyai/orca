import { useState } from 'react'
import { useAppStore } from '@/store'
import { containsAgentSpinnerGlyph } from '../../../shared/agent-title-glyphs'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import {
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { useTabAgent } from './use-tab-agent'

type HeldTabAgent = { agent: TerminalAgent; ptyId: string | null; processBacked: boolean }

/**
 * Keep the last resolved agent while its working spinner still leads the title. Hook rows can
 * vanish mid-turn and a bare spinner is activity, not identity, so the tab dropped to the terminal
 * icon with the raw glyph (#24315). A spinner-free title, a respawn, local OSC 133;D, or a process
 * reader that had seen this run and now reports none ends it. Split tabs whose siblings carry an
 * agent never arm it, since the resolved identity may belong to the sibling, not this PTY.
 */
function resolveStatusTitleHeldTabAgent(args: {
  resolved: TerminalAgent | null
  held: HeldTabAgent | null
  title: string
  ptyId: string | null
  foregroundAgent: TerminalAgent | null
  shellForeground: boolean
  siblingHasAgent: boolean
}): HeldTabAgent | null {
  if (args.siblingHasAgent) {
    return null
  }
  const held = args.held?.ptyId === args.ptyId ? args.held : null
  if (args.resolved) {
    // Why sticky: a confirmed exit clears the foreground agent but leaves shellForeground false.
    const processBacked = args.foregroundAgent !== null || held?.processBacked === true
    return { agent: args.resolved, ptyId: args.ptyId, processBacked }
  }
  const holdable =
    held !== null &&
    !held.processBacked &&
    !args.shellForeground &&
    // Braille and quarter-circle spinners are single UTF-16 units.
    containsAgentSpinnerGlyph(args.title.slice(0, 1))
  return holdable ? held : null
}

export function useStatusTitleHeldTabAgent(tab: TerminalTab): TerminalAgent | null {
  const resolved = useTabAgent(tab)
  const focusedPaneKey = useAppStore((s) => {
    const activeLeafId = s.terminalLayoutsByTabId[tab.id]?.activeLeafId
    return activeLeafId && isTerminalLeafId(activeLeafId) ? makePaneKey(tab.id, activeLeafId) : null
  })
  const foregroundAgent = useAppStore((s) =>
    focusedPaneKey ? (s.paneForegroundAgentByPaneKey[focusedPaneKey]?.agent ?? null) : null
  )
  const shellForeground = useAppStore((s) =>
    focusedPaneKey
      ? Boolean(s.paneForegroundAgentByPaneKey[focusedPaneKey]?.shellForeground)
      : false
  )
  const ptyId = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    const activeLeafId = layout?.activeLeafId
    const leafPty = activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : undefined
    if (leafPty) {
      return leafPty
    }
    const ptyIds = s.ptyIdsByTabId[tab.id] ?? []
    return ptyIds.length === 1 ? ptyIds[0]! : null
  })
  const siblingHasAgent = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    return (
      (resolveSiblingTabAgent(s.agentStatusByPaneKey, layout, tab.id) ??
        resolveSiblingCompletedTabAgent(s.agentStatusByPaneKey, layout, tab.id) ??
        resolveSiblingRetainedTabAgent(s.retainedAgentsByPaneKey, layout, tab.id)) !== null
    )
  })
  const [held, setHeld] = useState<HeldTabAgent | null>(null)
  const next = resolveStatusTitleHeldTabAgent({
    resolved,
    held,
    title: tab.title,
    ptyId,
    foregroundAgent,
    shellForeground,
    siblingHasAgent
  })
  // Why: render-phase update (React's "previous render" pattern) so the dropped-row frame never paints the fallback.
  if (
    next?.agent !== held?.agent ||
    next?.ptyId !== held?.ptyId ||
    next?.processBacked !== held?.processBacked
  ) {
    setHeld(next)
  }
  return resolved ?? next?.agent ?? null
}
