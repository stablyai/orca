import { useMemo } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '../../store'
import { resolvePaneWslDistro } from '../terminal-pane/terminal-pane-wsl-distro'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatAgentAccountReauthResult } from './NativeChatAgentNoticeBanner'

/**
 * Builds the "reauthenticate account" action for a `login-required` notice
 * banner. Only Claude has a managed-account reauth flow today, and only for a
 * pane this client actually runs — Orca's managed accounts are a local-host
 * concept, so an SSH-remote worktree's `claude` authenticates against ITS OWN
 * host and reauthenticating the local account there would be silently wrong.
 * Returns `undefined` whenever the action doesn't apply, so the banner falls
 * back to a plain descriptive notice with no CTA.
 */
export function useNativeChatAccountReauth(
  agent: NativeChatSession['agent'],
  worktreeId: string | undefined
): (() => Promise<NativeChatAgentAccountReauthResult>) | undefined {
  return useMemo(() => {
    if (agent !== 'claude' || !worktreeId || getConnectionId(worktreeId)) {
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
  }, [agent, worktreeId])
}
