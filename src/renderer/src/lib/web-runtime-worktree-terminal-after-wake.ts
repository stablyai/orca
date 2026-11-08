import { launchAgentInWebHostTab } from '@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab'
import { useAppStore } from '@/store'
import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import { createWebRuntimeSessionTerminal } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { isWebRuntimeSessionActive } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { isWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { getLastKnownHostTerminalTabCount } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn
} from '@/runtime/hosted-terminals/restoration/web-runtime-wake-terminal-respawn'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { WorktreeStartupPayload } from '@/lib/workspace/creation/worktree-startup-payload'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { toast } from 'sonner'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
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
): boolean {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return false
  }
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (!runtimeEnvironmentId || !isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return false
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
    return false
  }

  if (!launchAgent) {
    const hasLivePty = tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
    if (hasLivePty) {
      return false
    }

    const hasMirroredHostTabs = tabs.some((tab) => isWebTerminalSurfaceTabId(tab.id))
    if (hasMirroredHostTabs) {
      // Why: the host session still owns these tabs — wait for the mirror to repopulate PTY handles instead of duplicating a terminal.
      return false
    }

    const hostTerminalTabCount =
      getLastKnownHostTerminalTabCount(runtimeEnvironmentId, worktreeId) ??
      (opts?.unknownHostCountIsEmpty ? 0 : null)
    if (hostTerminalTabCount !== null && hostTerminalTabCount > 0) {
      return false
    }
    if (hostTerminalTabCount === null && !opts?.startup) {
      // Unlisted hosts cannot answer yet; their first real list seeds emptiness. Keep the capability gate until all supported hosts advertise it.
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
      return false
    }

    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (tabs.length === 0) {
      if (
        !shouldAutoCreateInitialTerminal(
          renderableTabCount,
          Object.hasOwn(state.tabsByWorktree, worktreeId)
        )
      ) {
        return false
      }
    } else if (renderableTabCount === 0) {
      return false
    }
  }

  if (!beginWebRuntimeWakeTerminalRespawn(worktreeId)) {
    return false
  }

  const startup = opts?.startup
  // Why: sleep keeps tab rows but terminal.stop clears host PTYs, while a failed create receipt leaves a selected agent with no host surface.
  const creation =
    startup?.freshAgentLaunch && launchAgent
      ? launchAgentInWebHostTab({
          ...startup.freshAgentLaunch,
          submitFollowup: true,
          agent: launchAgent,
          environmentId: runtimeEnvironmentId,
          worktreeId,
          activate: opts?.activate !== false,
          selectWorktree: false,
          buildStartup: () =>
            startup.freshAgentLaunch?.legacy?.() ?? {
              startupPlan: null,
              pasteDraftAfterLaunch: null,
              submitPastedPrompt: false
            }
        }).then((result) => result.outcome)
      : createWebRuntimeSessionTerminal(
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
  void creation
    .then((outcome) => {
      if (outcome.status === 'failed' && !startup?.freshAgentLaunch) {
        toast.error(outcome.message, {
          id: `web-runtime-worktree-terminal:${runtimeEnvironmentId}:${worktreeId}`
        })
      }
    })
    .finally(() => {
      endWebRuntimeWakeTerminalRespawn(worktreeId)
    })
  return true
}
