import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { isShellProcess, getAgentLabel } from '../../../shared/agent-detection'
import { worktreeUsesRemoteConnection } from '@/store/slices/terminals'
import { resolveTabAgent } from './tab-agent'
import type { TerminalTab, TuiAgent } from '../../../shared/types'

// Maps getAgentLabel()'s product labels to TuiAgent ids — the fallback for
// agents whose foreground PROCESS name isn't self-identifying (Claude Code runs
// as `node`, but its "✳ Claude Code" title resolves here). Agents whose process
// name already matches (codex, etc.) never reach this path.
const TITLE_LABEL_TO_AGENT: Partial<Record<string, TuiAgent>> = {
  'Claude Code': 'claude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  'GitHub Copilot': 'copilot',
  Grok: 'grok',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  Pi: 'pi'
}

function agentFromTitle(title: string): TuiAgent | null {
  const label = getAgentLabel(title)
  return label ? (TITLE_LABEL_TO_AGENT[label] ?? null) : null
}

/**
 * Resolve which coding-harness agent a terminal tab is running, for its tab-bar
 * icon. Layered signals, most-authoritative first:
 *
 * 1. Live foreground process — the ground truth for what's running *now*: the
 *    only signal that reverts to the terminal glyph when the agent exits to a
 *    shell, or flips when a different agent starts in the same pane. Checked
 *    event-driven (only when the tab's title changes — exactly when an agent
 *    starts/exits/takes a turn), never on an interval, and only for local panes
 *    (SSH foreground inspection is a 15s-timeout RPC). A recognized agent wins;
 *    a recognized shell authoritatively means "no agent".
 * 2. Title — catches agents whose process name isn't self-identifying (Claude
 *    runs as `node`; its "✳ Claude Code" title still identifies it).
 * 3. Hook status — accurate but only updates on the agent's hook events.
 * 4. launchAgent — what Orca launched here; instant bootstrap before any check.
 */
export function useTabAgent(tab: TerminalTab): TuiAgent | null {
  const hookAgent = useAppStore((s) =>
    resolveTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )

  // The focused pane's PTY (single-pane tabs have exactly one leaf).
  const ptyId = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    const activeLeafId = layout?.activeLeafId
    const leafPty = activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : undefined
    return leafPty ?? s.ptyIdsByTabId[tab.id]?.[0] ?? null
  })
  const isRemote = useAppStore((s) => worktreeUsesRemoteConnection(s, tab.worktreeId))

  // undefined = no conclusive local reading (defer to title/hook/launchAgent);
  // null = foreground is a shell; TuiAgent = recognized agent process.
  const [foreground, setForeground] = useState<TuiAgent | null | undefined>(undefined)

  useEffect(() => {
    if (!ptyId || isRemote) {
      setForeground(undefined)
      return
    }
    let cancelled = false
    // Why: re-runs when ptyId or tab.title changes — a title change is the event
    // signalling a possible foreground transition (agent start, exit, or turn).
    // One RPC per transition, not a timer; cancellation coalesces rapid churn.
    window.api.pty
      .getForegroundProcess(ptyId)
      .then((process) => {
        if (cancelled) {
          return
        }
        const recognized = recognizeAgentProcess(process)
        if (recognized) {
          setForeground(recognized.agent)
        } else if (process && isShellProcess(process)) {
          setForeground(null)
        } else {
          setForeground(undefined)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setForeground(undefined)
        }
      })
    return () => {
      cancelled = true
    }
  }, [ptyId, isRemote, tab.title])

  // Foreground is the live truth when conclusive (agent, or shell ⇒ null).
  if (!isRemote && foreground !== undefined) {
    return foreground
  }
  return agentFromTitle(tab.title) ?? hookAgent ?? tab.launchAgent ?? null
}
