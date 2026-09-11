import { useAppStore } from '@/store'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { isWebRuntimeSessionActive, isWebTerminalSurfaceTabId } from '@/runtime/web-runtime-session'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/web-runtime-terminal-create-operation'
import type { CreatedWebRuntimeSessionTerminal } from '@/runtime/web-runtime-session-types'
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
import { toast } from 'sonner'

export async function spawnWebRuntimeAgentSurface(
  worktreeId: string,
  opts?: {
    runtimeEnvironmentId?: string | null
    startup?: WorktreeStartupPayload
    agent?: TuiAgent | null
    cwd?: string | null
    activate?: boolean
  }
): Promise<CreatedWebRuntimeSessionTerminal | null> {
  const state = useAppStore.getState()
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!runtimeEnvironmentId || !isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return null
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
    return null
  }

  if (!launchAgent) {
    const hasLivePty = tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
    if (hasLivePty) {
      return null
    }

    const hasMirroredHostTabs = tabs.some((tab) => isWebTerminalSurfaceTabId(tab.id))
    if (hasMirroredHostTabs) {
      // Why: the host session still owns these tabs — wait for the mirror to repopulate PTY handles instead of duplicating a terminal.
      return null
    }

    if (getLastKnownHostTerminalTabCount(runtimeEnvironmentId, worktreeId) > 0) {
      return null
    }

    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    if (tabs.length > 0 && renderableTabCount === 0) {
      return null
    }
  }

  if (!beginWebRuntimeWakeTerminalRespawn(worktreeId)) {
    return null
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
  try {
    const created = await createWebRuntimeSessionTerminalResult({
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
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      activate: opts?.activate !== false,
      selectWorktree: false
    })
    if (created.outcome.status === 'failed') {
      toast.error(created.outcome.message, {
        id: `web-runtime-worktree-terminal:${runtimeEnvironmentId}:${worktreeId}`
      })
    }
    return created
  } finally {
    endWebRuntimeWakeTerminalRespawn(worktreeId)
  }
}

export function ensureWebRuntimeWorktreeTerminalAfterWake(
  worktreeId: string,
  opts?: Parameters<typeof spawnWebRuntimeAgentSurface>[1]
): void {
  void spawnWebRuntimeAgentSurface(worktreeId, opts)
}
