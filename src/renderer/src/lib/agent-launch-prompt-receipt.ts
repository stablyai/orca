import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'
import { getSettingsForAgentTabRuntimeOwner, PTY_SPAWN_TIMEOUT_MS } from './agent-paste-draft'

type AppState = ReturnType<typeof useAppStore.getState>

export type LaunchPromptReceipt = 'delivered' | 'not-delivered' | 'agent-exited' | 'unconfirmed'

/** How long a hook turn may still arrive after a read that could not tell. */
const HOOK_GRACE_AFTER_UNKNOWN_READ_MS = 2000
/** Reads start this often and back off: each forks one `ps` on the execution host. */
const FIRST_READ_INTERVAL_MS = 250
const MAX_READ_INTERVAL_MS = 2000
/** How long after the ready signal the shell may stay in front before the launch line runs: a
 *  slow shell startup can draw its prompt, and look ready, before it types the line. */
const LAUNCH_LINE_WAIT_AFTER_READY_MS = 30_000

function hookReportedTurnOnTab(state: AppState, tabId: string, launchedAt: number): boolean {
  return Object.entries(state.agentStatusByPaneKey).some(
    ([paneKey, entry]) => parsePaneKey(paneKey)?.tabId === tabId && entry.updatedAt >= launchedAt
  )
}

function tabExists(state: AppState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs?.some((tab) => tab.id === tabId))
}

type TerminalForeground = 'launched-agent' | 'other' | 'shell' | 'unknown'

async function readTerminalForeground(ptyId: string, agent: TuiAgent): Promise<TerminalForeground> {
  // A paired host's process reads do not reach this client.
  if (isRemoteRuntimePtyId(ptyId)) {
    return 'unknown'
  }
  return window.api.pty.readLaunchedAgentForeground(ptyId, agent).catch(() => 'unknown' as const)
}

/**
 * Whether a prompt that rode an agent's launch command reached the agent, read with #24257's
 * crash-guard predicate (`readLaunchedAgentForeground`), which tells the launched agent named on its
 * command line from any other process that is not the shell. Delivered on the agent's own hook turn
 * on the tab, or on a process other than the shell in front once the agent looks ready (one behind
 * a wrapper or a command override counts); the ready signal never counts on its own, and bracketed
 * paste turned off (`2004l`) revokes it. Not delivered when the PTY never spawns (a
 * refused launch file included) or the tab closes. Agent exited only on proof it ran and ended:
 * the launched agent was in front, then the shell came back or the PTY exited. A shell in front
 * before then is a launch line not yet run (a slow shell startup), so the reads go on until the
 * agent is in front, or for 30 s after the ready signal. Unconfirmed when nothing proves either,
 * as on a Windows host without hooks.
 */
export function waitForLaunchPromptReceipt(args: {
  tabId: string
  agent: TuiAgent
  launchedAt: number
}): Promise<LaunchPromptReceipt> {
  const { tabId, agent, launchedAt } = args
  return new Promise((resolve) => {
    let settled = false
    let boundPtyId: string | null = null
    let unsubscribe: (() => void) | null = null
    const timers: number[] = []
    const finish = (receipt: LaunchPromptReceipt): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribe?.()
      timers.forEach((timer) => window.clearTimeout(timer))
      resolve(receipt)
    }
    let agentSeen = false
    const watchForeground = (ptyId: string): void => {
      const config = TUI_AGENT_CONFIG[agent]
      let ready = false
      let graceArmed = false
      let interval = FIRST_READ_INTERVAL_MS
      let reading = false
      let nextRead: number | null = null
      const read = async (): Promise<void> => {
        nextRead = null
        reading = true
        const foreground = await readTerminalForeground(ptyId, agent)
        reading = false
        if (settled) {
          return
        }
        agentSeen ||= foreground === 'launched-agent'
        if ((foreground === 'launched-agent' || foreground === 'other') && ready) {
          finish('delivered')
        } else if (foreground === 'shell' && agentSeen) {
          finish('agent-exited')
        } else {
          if (foreground === 'unknown' && ready && !graceArmed) {
            graceArmed = true
            timers.push(
              window.setTimeout(() => finish('unconfirmed'), HOOK_GRACE_AFTER_UNKNOWN_READ_MS)
            )
          }
          nextRead = window.setTimeout(() => void read(), interval)
          timers.push(nextRead)
          interval = Math.min(interval * 2, MAX_READ_INTERVAL_MS)
        }
      }
      void waitForAgentDraftInputReady(
        ptyId,
        resolveDraftPasteReadyTimeoutMs(agent),
        config.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste',
        getSettingsForAgentTabRuntimeOwner(tabId),
        { revokeOnBracketedPasteOff: true }
      )
        .then(() => {
          ready = true
          timers.push(
            window.setTimeout(() => finish('unconfirmed'), LAUNCH_LINE_WAIT_AFTER_READY_MS)
          )
          // Why: the read the ready signal times runs now, not at the backed-off interval.
          interval = FIRST_READ_INTERVAL_MS
          if (!reading && !settled) {
            if (nextRead !== null) {
              window.clearTimeout(nextRead)
            }
            void read().catch(() => finish('unconfirmed'))
          }
        })
        .catch(() => finish('unconfirmed'))
      void read().catch(() => finish('unconfirmed'))
    }
    let scannedStatus: AppState['agentStatusByPaneKey'] | null = null
    // Why: Command Code has no hook; its launch seeds a working row from the prompt itself (the new
    // agent tab and workspace creation), which proves nothing, so only the foreground read does.
    const statusRowProvesTurn = agent !== 'command-code'
    const observe = (state: AppState): void => {
      // Why the identity check: the store writes often and replaces this map only when it changes.
      if (state.agentStatusByPaneKey !== scannedStatus) {
        scannedStatus = state.agentStatusByPaneKey
        if (statusRowProvesTurn && hookReportedTurnOnTab(state, tabId, launchedAt)) {
          finish('delivered')
          return
        }
      }
      const ptyId = state.ptyIdsByTabId[tabId]?.[0]
      if (ptyId && !boundPtyId) {
        boundPtyId = ptyId
        watchForeground(ptyId)
      } else if (!tabExists(state, tabId)) {
        finish('not-delivered')
      } else if (boundPtyId && !ptyId) {
        finish(agentSeen ? 'agent-exited' : 'unconfirmed')
      }
    }
    unsubscribe = useAppStore.subscribe(observe)
    timers.push(
      window.setTimeout(() => {
        if (!boundPtyId) {
          finish('not-delivered')
        }
      }, PTY_SPAWN_TIMEOUT_MS)
    )
    observe(useAppStore.getState())
  })
}
