import { useEffect } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'

export function useAiVaultCursorAgentDetection({
  sessions,
  effectiveActiveWorktreeId,
  sessionWorktreeById,
  ensureDetectedAgents,
  ensureRemoteDetectedAgents,
  ensureRuntimeDetectedAgents
}: {
  sessions: readonly AiVaultSession[]
  effectiveActiveWorktreeId: string | null
  sessionWorktreeById: ReadonlyMap<string, { worktreeId?: string | null }>
  ensureDetectedAgents: (worktreeId?: string) => Promise<unknown>
  ensureRemoteDetectedAgents: (targetId: string) => Promise<unknown>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<unknown>
}): void {
  useEffect(() => {
    const cursorSessions = sessions.filter((session) => session.agent === 'cursor')
    const cursorHostIds = new Set(cursorSessions.map((session) => session.executionHostId))
    const localWorktreeIds = new Set<string>()
    if (effectiveActiveWorktreeId) {
      localWorktreeIds.add(effectiveActiveWorktreeId)
    }
    for (const session of cursorSessions) {
      const worktreeId = sessionWorktreeById.get(session.id)?.worktreeId
      if (worktreeId) {
        localWorktreeIds.add(worktreeId)
      }
    }
    let hasLocalCursorSession = false
    for (const hostId of cursorHostIds) {
      const host = parseExecutionHostId(hostId)
      if (host?.kind === 'ssh') {
        void ensureRemoteDetectedAgents(host.targetId)
      } else if (host?.kind === 'runtime') {
        void ensureRuntimeDetectedAgents(host.environmentId)
      } else {
        hasLocalCursorSession = true
      }
    }
    if (!hasLocalCursorSession) {
      return
    }
    if (localWorktreeIds.size === 0) {
      void ensureDetectedAgents()
      return
    }
    for (const worktreeId of localWorktreeIds) {
      void ensureDetectedAgents(worktreeId)
    }
  }, [
    effectiveActiveWorktreeId,
    ensureDetectedAgents,
    ensureRemoteDetectedAgents,
    ensureRuntimeDetectedAgents,
    sessionWorktreeById,
    sessions
  ])
}
