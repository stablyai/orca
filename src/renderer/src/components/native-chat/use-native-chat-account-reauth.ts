import { useMemo } from 'react'
import { getConnectionId, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { useAppStore } from '../../store'
import { resolvePaneWslDistro } from '../terminal-pane/terminal-pane-wsl-distro'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatAgentAccountReauthResult } from './NativeChatAgentNoticeBanner'

/** Builds the login-required notice's "reauthenticate account" action —
 *  Claude-only, and only for a pane this client runs locally, since a remote
 *  pane's `claude` authenticates against its own host, not Orca's local
 *  managed accounts. `undefined` when it doesn't apply (SSH, runtime-owned,
 *  or connection ownership still unresolved), so the banner falls back to a
 *  plain notice with no CTA. */
export function useNativeChatAccountReauth(
  agent: NativeChatSession['agent'],
  worktreeId: string | undefined,
  runtimeEnvironmentId: string | null
): (() => Promise<NativeChatAgentAccountReauthResult>) | undefined {
  return useMemo(() => {
    if (
      agent !== 'claude' ||
      !worktreeId ||
      runtimeEnvironmentId ||
      !isWorktreeConnectionResolved(worktreeId) ||
      getConnectionId(worktreeId)
    ) {
      return undefined
    }
    return async () => {
      try {
        const state = useAppStore.getState()
        const worktreePath = state.allWorktrees().find((w) => w.id === worktreeId)?.path ?? ''
        const wslDistro = resolvePaneWslDistro(state, worktreeId, worktreePath)
        await window.api.claudeAccounts.reauthenticateForTarget(
          wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
        )
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
  }, [agent, worktreeId, runtimeEnvironmentId])
}
