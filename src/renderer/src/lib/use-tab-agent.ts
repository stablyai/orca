/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: tab agent foreground state is synchronized from PTY/remote agent signals and shell foreground events. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/agent-detection'
import { worktreeUsesRemoteConnection } from '@/store/slices/terminals'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TerminalTab, TuiAgent } from '../../../shared/types'

export { resolveExplicitTerminalTitleAgentType as resolveTabAgentFromTitle } from '../../../shared/terminal-title-agent-type'

const HELPER_FOREGROUND_RETRY_DELAYS_MS = [250, 1250, 3500, 750] as const

function getTitleForegroundKey(title: string, launchAgent?: TuiAgent): string {
  const titleAgent = launchAgent ? null : resolveExplicitTerminalTitleAgentType(title)
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
  const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(args.title)
  // Why: when a pane is reused for a different agent, its launchAgent goes stale.
  // A live title that explicitly names a *different* agent, once the pane has
  // shown any activity, overrides that stale launch identity so the tab icon
  // tracks what is actually running (codex launch reused for claude, etc.).
  const titleOverridesLaunch =
    launchAgent !== null &&
    explicitTitleAgent !== null &&
    explicitTitleAgent !== launchAgent &&
    args.hasObservedAgentSignal
  const titleAgent = titleOverridesLaunch
    ? explicitTitleAgent
    : launchAgent
      ? null
      : explicitTitleAgent
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
  // Why: titleAgent now ranks ahead of launch/fallback hooks because, once the
  // pane has shown activity, a live explicit title is the freshest identity
  // signal — it beats a launchAgent gone stale through pane reuse. Before any
  // activity, titleAgent is null while launchAgent exists, so launch bootstrap
  // still wins the startup window.
  if (args.isRemote || args.foreground === undefined) {
    return focusedHookAgent ?? titleAgent ?? activeLaunchAgent ?? fallbackHookAgent
  }
  if (args.foreground) {
    return args.foreground
  }
  // Why: once a local pane has returned to a shell, a stale hook should not keep
  // painting it as an agent tab.
  if (args.shellForegroundAfterAgentSignal) {
    return null
  }
  return focusedHookAgent ?? titleAgent ?? activeLaunchAgent ?? fallbackHookAgent
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
 * 4. Title — legacy/unknown-session fallback, and the live override when a pane
 *    is reused: once the pane has shown activity, a title that explicitly names
 *    a different agent than launchAgent wins over that stale launch identity.
 *    Otherwise it is ignored while launchAgent exists, and generic spinner-only
 *    titles never identify an agent.
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
      !tab.launchAgent && (resolveExplicitTerminalTitleAgentType(tab.title) || siblingHookAgent)
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
    const localPtyId = ptyId
    let cancelled = false
    const helperForegroundRetryTimers: number[] = []
    // Why: re-runs when ptyId or tab.title changes — a title change is the event
    // signalling a possible foreground transition (agent start, exit, or turn).
    // One RPC per transition, not a timer; cancellation coalesces rapid churn.
    function readForeground(retryIndex = 0): void {
      window.api.pty
        .getForegroundProcess(localPtyId)
        .then((process) => {
          applyForegroundProcess(process, retryIndex)
        })
        .catch(() => {
          if (!cancelled) {
            setForeground(undefined)
          }
        })
    }
    function scheduleHelperForegroundRetry(retryIndex: number): void {
      const delay = HELPER_FOREGROUND_RETRY_DELAYS_MS[retryIndex]
      if (delay === undefined) {
        return
      }
      // Why: the daemon resolves shell/helper -> agent ancestry asynchronously
      // after the first foreground read, so give its short cache a bounded re-read.
      const timer = window.setTimeout(() => {
        readForeground(retryIndex + 1)
      }, delay)
      helperForegroundRetryTimers.push(timer)
    }
    function applyForegroundProcess(process: string | null, retryIndex: number): void {
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
        if (tab.launchAgent && !hasObservedAgentSignalRef.current) {
          scheduleHelperForegroundRetry(retryIndex)
        }
      } else {
        if (process && tab.launchAgent) {
          // Why: for Orca-owned launches, an unrecognized non-shell process
          // is enough lifecycle evidence to clear launch intent when the pane
          // later returns to a shell, without using title text as identity.
          hasObservedAgentSignalRef.current = true
          setHasObservedAgentSignal(true)
        }
        setForeground(undefined)
        if (process && tab.launchAgent) {
          scheduleHelperForegroundRetry(retryIndex)
        }
      }
    }
    readForeground()
    return () => {
      cancelled = true
      helperForegroundRetryTimers.forEach((timer) => window.clearTimeout(timer))
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
