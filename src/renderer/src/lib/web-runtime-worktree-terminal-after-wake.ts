import { useAppStore } from '@/store'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import { getLastKnownHostTerminalTabCount } from '@/runtime/web-session-tabs-sync'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  draftViewModeProps,
  resolveStartupLaunchDraftText,
  type WorktreeStartupPayload
} from '@/lib/worktree-startup-payload'
import type { TuiAgent } from '../../../shared/tui-agent'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getConnectionId } from '@/lib/connection-context'

export function ensureWebRuntimeWorktreeTerminalAfterWake(
  worktreeId: string,
  opts?: {
    runtimeEnvironmentId?: string | null
    startup?: WorktreeStartupPayload
    agent?: TuiAgent | null
    activate?: boolean
  }
): void {
  const state = useAppStore.getState()
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForWorktree(state, worktreeId)
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

    if (getLastKnownHostTerminalTabCount(runtimeEnvironmentId, worktreeId) > 0) {
      return
    }

    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (tabs.length > 0 && renderableTabCount === 0) {
      return
    }
  }

  if (!beginWebRuntimeWakeTerminalRespawn(worktreeId)) {
    return
  }

  const startup = opts?.startup
  const viewModeProps = launchAgent
    ? initialAgentTabViewModeProps(state.settings, {
        agent: launchAgent,
        ...draftViewModeProps(resolveStartupLaunchDraftText(startup)),
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
          getConnectionId(worktreeId)
        )
      })
    : {}
  // Why: sleep keeps tab rows but terminal.stop clears host PTYs, while a failed create receipt leaves a selected agent with no host surface.
  void createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId: runtimeEnvironmentId,
    ...viewModeProps,
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
  }).finally(() => {
    endWebRuntimeWakeTerminalRespawn(worktreeId)
  })
}
