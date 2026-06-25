/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: tab agent foreground state is synchronized from PTY/remote agent signals and shell foreground events. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { isShellProcess, getAgentLabel, titleHasAgentName } from '../../../shared/agent-detection'
import { worktreeUsesRemoteConnection } from '@/store/slices/terminals'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
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
  Devin: 'devin',
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

function agentFromTabTitle(title: string): TuiAgent | null {
  const titleAgent = agentFromTitle(title)
  if (isGenericClaudeStatusClaim(title, titleAgent)) {
    // Why: bare Claude status prefixes are activity evidence, not identity.
    // Keep them out of tab icons so task/worktree titles cannot become Claude
    // without a hook, launch intent, foreground process, or explicit name.
    return null
  }
  return titleAgent
}

function getTitleForegroundKey(title: string, launchAgent?: TuiAgent): string {
  const titleAgent = launchAgent ? null : agentFromTabTitle(title)
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
  siblingHookAgent?: TuiAgent | null
  hasCompletedHook: boolean
  completedHookAgent?: TuiAgent | null
  launchAgent?: TuiAgent
}): TuiAgent | null {
  const launchAgent = args.launchAgent ?? null
  const titleAgent = launchAgent ? null : agentFromTabTitle(args.title)
  const titleLooksShell = isShellProcess(args.title)
  // Why: remote panes cannot cheaply prove shell foreground after hook exit,
  // so keep the last completed hook identity instead of flashing unknown.
  const completedHookAgent =
    !args.isRemote && titleLooksShell && args.hasCompletedHook ? null : args.completedHookAgent
  const focusedHookAgent = args.hookAgent ?? null
  const fallbackHookAgent = args.siblingHookAgent ?? completedHookAgent ?? null
  const localShellForegroundClearedLaunch =
    !args.isRemote && args.foreground === null && args.shellForegroundAfterAgentSignal
  const remoteCompletedHookAtShellTitle = args.isRemote && titleLooksShell && args.hasCompletedHook
  const activeLaunchAgent =
    localShellForegroundClearedLaunch || remoteCompletedHookAtShellTitle ? null : launchAgent
  if (args.isRemote || args.foreground === undefined) {
    return focusedHookAgent ?? activeLaunchAgent ?? fallbackHookAgent ?? titleAgent
  }
  if (args.foreground) {
    return args.foreground
  }
  // Why: once a local pane has returned to a shell, a stale hook should not keep
  // painting it as an agent tab.
  if (args.shellForegroundAfterAgentSignal) {
    return null
  }
  return focusedHookAgent ?? activeLaunchAgent ?? fallbackHookAgent ?? titleAgent
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
 * 3. launchAgent — what Orca launched here; instant bootstrap before hooks or
 *    foreground polling arrive, and the owned identity for startup windows.
 * 4. Title — legacy/unknown-session fallback only. It is ignored while
 *    launchAgent exists, and generic spinner-only titles do not identify an agent.
 */
export function useTabAgent(tab: TerminalTab): TuiAgent | null {
  const focusedHookAgent = useAppStore((s) =>
    resolveFocusedTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const siblingHookAgent = useAppStore((s) =>
    resolveSiblingTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const focusedCompletedHookAgent = useAppStore((s) =>
    resolveFocusedCompletedTabAgent(
      s.agentStatusByPaneKey,
      s.terminalLayoutsByTabId[tab.id],
      tab.id
    )
  )
  const siblingCompletedHookAgent = useAppStore((s) =>
    resolveSiblingCompletedTabAgent(
      s.agentStatusByPaneKey,
      s.terminalLayoutsByTabId[tab.id],
      tab.id
    )
  )
  const completedHookAgent = focusedCompletedHookAgent ?? siblingCompletedHookAgent
  const hasCompletedHook = focusedCompletedHookAgent !== null
  const clearTabLaunchAgent = useAppStore((s) => s.clearTabLaunchAgent)

  // The focused pane's PTY (single-pane tabs have exactly one leaf).
  const ptyId = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    const activeLeafId = layout?.activeLeafId
    const leafPty = activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : undefined
    if (leafPty) {
      return leafPty
    }
    const ptyIds = s.ptyIdsByTabId[tab.id] ?? []
    // Why: without a focused leaf, a split tab's first PTY can be a sibling
    // shell. Only single-PTY fallback foreground is authoritative.
    return ptyIds.length === 1 ? ptyIds[0]! : null
  })
  const hasRemoteRuntimePty = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tab.id]
    const ptyIds = new Set(s.ptyIdsByTabId[tab.id] ?? [])
    for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
      ptyIds.add(ptyId)
    }
    return [...ptyIds].some((ptyId) => parseRemoteRuntimePtyId(ptyId) !== null)
  })
  const isRemoteWorktree = useAppStore((s) => worktreeUsesRemoteConnection(s, tab.worktreeId))
  const isRemoteLike = isRemoteWorktree || hasRemoteRuntimePty

  // undefined = no conclusive local reading (defer to title/hook/launchAgent);
  // null = foreground is a shell; TuiAgent = recognized agent process.
  const [foreground, setForeground] = useState<TuiAgent | null | undefined>(undefined)
  const [hasObservedAgentSignal, setHasObservedAgentSignal] = useState(false)
  const [shellForegroundAfterAgentSignal, setShellForegroundAfterAgentSignal] = useState(false)
  const hasObservedAgentSignalRef = useRef(false)
  const titleForegroundKey = getTitleForegroundKey(tab.title, tab.launchAgent)

  useEffect(() => {
    setForeground(undefined)
    setHasObservedAgentSignal(false)
    hasObservedAgentSignalRef.current = false
    setShellForegroundAfterAgentSignal(false)
  }, [ptyId, isRemoteLike])

  useEffect(() => {
    const fallbackAgentSignal =
      !tab.launchAgent && (agentFromTabTitle(tab.title) || siblingHookAgent)
    // Why: a completed structured hook proves a launched agent existed, but
    // local launch cleanup still waits for current foreground-shell evidence.
    if (focusedHookAgent || hasCompletedHook || fallbackAgentSignal) {
      hasObservedAgentSignalRef.current = true
      setHasObservedAgentSignal(true)
    }
  }, [focusedHookAgent, hasCompletedHook, siblingHookAgent, tab.launchAgent, tab.title])

  useEffect(() => {
    if (!ptyId || isRemoteLike) {
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
          if (process && tab.launchAgent) {
            // Why: for Orca-owned launches, an unrecognized non-shell process
            // is enough lifecycle evidence to clear launch intent when the pane
            // later returns to a shell, without using title text as identity.
            hasObservedAgentSignalRef.current = true
            setHasObservedAgentSignal(true)
          }
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
  }, [ptyId, isRemoteLike, tab.launchAgent, titleForegroundKey])

  useEffect(() => {
    if (!tab.launchAgent) {
      return
    }
    const titleLooksShell = isShellProcess(tab.title)
    const foregroundSawExitedAgent =
      !isRemoteLike && foreground === null && shellForegroundAfterAgentSignal
    const remoteHookCompletedAtShellTitle = isRemoteLike && hasCompletedHook && titleLooksShell
    if (foregroundSawExitedAgent || remoteHookCompletedAtShellTitle) {
      clearTabLaunchAgent(tab.id)
    }
  }, [
    clearTabLaunchAgent,
    foreground,
    hasCompletedHook,
    isRemoteLike,
    shellForegroundAfterAgentSignal,
    tab.id,
    tab.launchAgent,
    tab.title
  ])

  return resolveTabAgentFromSignals({
    foreground,
    hasObservedAgentSignal,
    shellForegroundAfterAgentSignal,
    isRemote: isRemoteLike,
    title: tab.title,
    hookAgent: focusedHookAgent,
    siblingHookAgent,
    hasCompletedHook,
    completedHookAgent,
    launchAgent: tab.launchAgent
  })
}
