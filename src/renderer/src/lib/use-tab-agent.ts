/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: tab agent foreground state is synchronized from PTY/remote agent signals and shell foreground events. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { isShellProcess, getAgentLabel } from '../../../shared/agent-detection'
import { worktreeUsesRemoteConnection } from '@/store/slices/terminals'
import { resolveCompletedTabAgent, resolveTabAgent } from './tab-agent'
import type { TerminalTab, TuiAgent } from '../../../shared/types'

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

function getTitleForegroundKey(title: string): string {
  const titleAgent = agentFromTitle(title)
  if (titleAgent) {
    return `agent:${titleAgent}`
  }
  if (isShellProcess(title)) {
    return 'shell'
  }
  const stableTitle = title
    .trim()
    .toLowerCase()
    // Why: unknown agents may still animate leading status glyphs. Include the
    // stable title body so first launch from "Terminal 1" triggers one poll,
    // without polling on every spinner frame.
    .replace(/^(?:[✳✦⏲◇✋⠀-⣿]+|[.*]\s)\s*/, '')
    .slice(0, 48)
  return `unknown:${stableTitle}`
}

export function resolveTabAgentFromSignals(args: {
  foreground: TuiAgent | null | undefined
  hasObservedAgentSignal: boolean
  shellForegroundAfterAgentSignal: boolean
  isRemote: boolean
  title: string
  hookAgent: TuiAgent | null
  hasCompletedHook: boolean
  completedHookAgent?: TuiAgent | null
  launchAgent?: TuiAgent
}): TuiAgent | null {
  const titleAgent = agentFromTitle(args.title)
  const titleLooksShell = isShellProcess(args.title)
  // Why: remote panes cannot cheaply prove shell foreground after hook exit,
  // so keep the last completed hook identity instead of flashing unknown.
  const completedHookAgent =
    !args.isRemote && titleLooksShell && args.hasCompletedHook ? null : args.completedHookAgent
  const hookAgent = args.hookAgent ?? completedHookAgent ?? null
  const launchAgent =
    args.hasCompletedHook || (titleLooksShell && args.hasObservedAgentSignal)
      ? null
      : (args.launchAgent ?? null)
  if (args.isRemote || args.foreground === undefined) {
    return hookAgent ?? titleAgent ?? launchAgent
  }
  if (args.foreground) {
    return args.foreground
  }
  // Why: once a local pane has returned to a shell, a stale hook should not keep
  // painting it as an agent tab.
  if (args.shellForegroundAfterAgentSignal) {
    return null
  }
  return hookAgent ?? titleAgent ?? launchAgent
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
 * 2. Hook status — accurate provider identity from native integrations, and
 *    available for SSH/remote panes where foreground polling is too costly.
 * 3. Title — catches agents whose process name isn't self-identifying (Claude
 *    runs as `node`; its "✳ Claude Code" title still identifies it).
 * 4. launchAgent — what Orca launched here; instant bootstrap before any check.
 */
export function useTabAgent(tab: TerminalTab): TuiAgent | null {
  const hookAgent = useAppStore((s) =>
    resolveTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const completedHookAgent = useAppStore((s) =>
    resolveCompletedTabAgent(s.agentStatusByPaneKey, tab.id)
  )
  const hasCompletedHook = completedHookAgent !== null
  const clearTabLaunchAgent = useAppStore((s) => s.clearTabLaunchAgent)

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
  const [hasObservedAgentSignal, setHasObservedAgentSignal] = useState(false)
  const [shellForegroundAfterAgentSignal, setShellForegroundAfterAgentSignal] = useState(false)
  const hasObservedAgentSignalRef = useRef(false)
  const titleForegroundKey = getTitleForegroundKey(tab.title)

  useEffect(() => {
    setForeground(undefined)
    setHasObservedAgentSignal(false)
    hasObservedAgentSignalRef.current = false
    setShellForegroundAfterAgentSignal(false)
  }, [ptyId, isRemote])

  useEffect(() => {
    if (agentFromTitle(tab.title) || hookAgent) {
      hasObservedAgentSignalRef.current = true
      setHasObservedAgentSignal(true)
    }
  }, [hookAgent, tab.title])

  useEffect(() => {
    if (!ptyId || isRemote) {
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
          hasObservedAgentSignalRef.current = true
          setHasObservedAgentSignal(true)
          setForeground(recognized.agent)
        } else if (process && isShellProcess(process)) {
          setShellForegroundAfterAgentSignal(hasObservedAgentSignalRef.current)
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
  }, [ptyId, isRemote, titleForegroundKey])

  useEffect(() => {
    if (!tab.launchAgent) {
      return
    }
    const titleLooksShell = isShellProcess(tab.title)
    const titleAgent = agentFromTitle(tab.title)
    const foregroundSawExitedAgent =
      !isRemote && foreground === null && shellForegroundAfterAgentSignal && !titleAgent
    const titleSawExitedAgent = titleLooksShell && hasObservedAgentSignal
    const remoteHookCompletedAtShellTitle = isRemote && hasCompletedHook && titleLooksShell
    if (foregroundSawExitedAgent || titleSawExitedAgent || remoteHookCompletedAtShellTitle) {
      clearTabLaunchAgent(tab.id)
    }
  }, [
    clearTabLaunchAgent,
    foreground,
    hasCompletedHook,
    hasObservedAgentSignal,
    isRemote,
    shellForegroundAfterAgentSignal,
    tab.id,
    tab.launchAgent,
    tab.title
  ])

  return resolveTabAgentFromSignals({
    foreground,
    hasObservedAgentSignal,
    shellForegroundAfterAgentSignal,
    isRemote,
    title: tab.title,
    hookAgent,
    hasCompletedHook,
    completedHookAgent,
    launchAgent: tab.launchAgent
  })
}
