import { useAppStore } from '@/store'
import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import { createWebRuntimeSessionTerminal } from '@/runtime/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getLastKnownHostTerminalTabCount } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import type { TuiAgent } from '../../../shared/tui-agent'
import { toast } from 'sonner'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { SESSION_TABS_EMPTY_WORKTREE_ANSWER_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'

export function ensureWebRuntimeWorktreeTerminalAfterWake(
  worktreeId: string,
  opts?: {
    runtimeEnvironmentId?: string | null
    startup?: WorktreeStartupPayload
    agent?: TuiAgent | null
    activate?: boolean
    /** The caller knows an unlisted workspace is empty: it just created it, or the host never answers. */
    unknownHostCountIsEmpty?: boolean
  }
): void {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return
  }
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (!runtimeEnvironmentId || !isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return
  }

  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const launchAgent = opts?.startup?.launchAgent ?? opts?.agent ?? undefined
  if (
    launchAgent &&
    tabs.some(
      (tab) =>
        tab.launchAgent === launchAgent &&
        (isWebTerminalSurfaceTabId(tab.id) || tabHasLivePty(state.ptyIdsByTabId, tab.id))
    )
  ) {
    return
  }

  if (!launchAgent) {
    const hasLivePty = tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
    if (hasLivePty) {
      return
    }

    const hasMirroredHostTabs = tabs.some((tab) => isWebTerminalSurfaceTabId(tab.id))
    if (hasMirroredHostTabs) {
      // Why: the host session still owns these tabs — wait for the mirror to repopulate PTY handles instead of duplicating a terminal.
      return
    }

    const hostTerminalTabCount =
      getLastKnownHostTerminalTabCount(runtimeEnvironmentId, worktreeId) ??
      (opts?.unknownHostCountIsEmpty ? 0 : null)
    if (hostTerminalTabCount !== null && hostTerminalTabCount > 0) {
      return
    }
    if (hostTerminalTabCount === null && !opts?.startup) {
      // Why: the host has not listed this workspace yet; its first real answer seeds the terminal if
      // empty. Delete this capability check once every supported host advertises it.
      void runtimeEnvironmentSupportsCapability(
        runtimeEnvironmentId,
        SESSION_TABS_EMPTY_WORKTREE_ANSWER_RUNTIME_CAPABILITY
      )
        .catch(() => false)
        .then((hostAnswersLater) => {
          if (!hostAnswersLater) {
            ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId, {
              ...opts,
              runtimeEnvironmentId,
              unknownHostCountIsEmpty: true
            })
          }
        })
        .catch((error) => {
          console.error('web runtime terminal after wake failed', worktreeId, error)
        })
      return
    }

    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (tabs.length === 0) {
      if (
        !shouldAutoCreateInitialTerminal(
          renderableTabCount,
          Object.hasOwn(state.tabsByWorktree, worktreeId)
        )
      ) {
        return
      }
    } else if (renderableTabCount === 0) {
      return
    }
  }

  if (!beginWebRuntimeWakeTerminalRespawn(worktreeId)) {
    return
  }

  const startup = opts?.startup
  // Why: sleep keeps tab rows but terminal.stop clears host PTYs, while a failed create receipt leaves a selected agent with no host surface.
  void createWebRuntimeSessionTerminal(
    {
      worktreeId,
      environmentId: runtimeEnvironmentId,
      ...(startup
        ? {
            command: startup.command,
            ...(startup.env ? { env: startup.env } : {}),
            ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
            ...(startup.launchToken ? { launchToken: startup.launchToken } : {}),
            ...(launchAgent ? { launchAgent, preparedAgentCommand: true } : {}),
            ...(startup.startupCommandDelivery
              ? { startupCommandDelivery: startup.startupCommandDelivery }
              : {})
          }
        : launchAgent
          ? { agent: launchAgent }
          : {}),
      activate: opts?.activate !== false,
      selectWorktree: false
    },
    // This flow toasts every failure itself, including a disconnected host.
    { notifyFailure: false }
  )
    .then((outcome) => {
      if (outcome.status === 'failed') {
        toast.error(outcome.message, {
          id: `web-runtime-worktree-terminal:${runtimeEnvironmentId}:${worktreeId}`
        })
      }
    })
    .finally(() => {
      endWebRuntimeWakeTerminalRespawn(worktreeId)
    })
}
