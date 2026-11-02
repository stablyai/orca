import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { withAiVaultSessionCwdAliases } from '../../../../shared/ai-vault-session-cwd-aliases'

type SubagentListState = {
  sessions: AiVaultSession[]
  status: 'loading' | 'loaded' | 'error'
}

// The caller keys the branch by transcript identity; rescans retain its loaded rows.
export function useSubagentSessions(
  session: AiVaultSession
): SubagentListState & { retry: () => void; showLoading: boolean } {
  const [state, setState] = useState<SubagentListState>({ status: 'loading', sessions: [] })
  const [showLoading, setShowLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    setShowLoading(false)
    const loadingTimer = setTimeout(() => setShowLoading(true), 200)
    setState((previous) => ({ ...previous, status: 'loading' }))
    window.api.aiVault
      .listSubagentSessions({
        agent: session.agent,
        parentFilePath: session.filePath,
        executionHostId: session.executionHostId
      })
      .then((result) => {
        clearTimeout(loadingTimer)
        if (!cancelled) {
          setState({
            status: result.issues.some((issue) => issue.kind !== 'notice') ? 'error' : 'loaded',
            sessions: result.sessions
          })
        }
      })
      .catch(() => {
        clearTimeout(loadingTimer)
        if (!cancelled) {
          setState((previous) => ({ ...previous, status: 'error' }))
        }
      })
    return () => {
      cancelled = true
      clearTimeout(loadingTimer)
    }
  }, [
    session.agent,
    session.filePath,
    session.executionHostId,
    session.subagentTranscriptCount,
    session.modifiedAt,
    attempt
  ])
  const { agent, cwd, executionHostId, filePath } = session
  // IPC clones equal alias arrays when only parent metadata changes.
  const retainCwdAliases = useShallow((aliases: AiVaultSession['cwdAliases']) => aliases)
  const cwdAliases = retainCwdAliases(session.cwdAliases)
  const sessions = useMemo(() => {
    if (!cwdAliases?.length) {
      return state.sessions
    }
    const source = { agent, cwd, cwdAliases, executionHostId, filePath }
    return state.sessions.map((child) => withAiVaultSessionCwdAliases(child, source))
  }, [state.sessions, agent, cwd, cwdAliases, executionHostId, filePath])
  return {
    ...state,
    sessions,
    showLoading: showLoading && state.status === 'loading',
    retry: () => setAttempt((value) => value + 1)
  }
}
