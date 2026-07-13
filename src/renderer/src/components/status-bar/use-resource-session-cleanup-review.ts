import { useCallback, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '../../store'
import type {
  PtyCleanupInspection,
  PtyInactiveCleanupResult
} from '../../../../shared/pty-inactive-cleanup'
import type { ResourceSessionBindingInputs } from './resource-session-bindings'
import type { DaemonSession } from './resource-usage-merge-types'
import {
  executeResourceSessionCleanup,
  reviewResourceSessionCleanup,
  type ResourceSessionCleanupReview,
  type ResourceSessionCleanupReviewState
} from './resource-session-cleanup-review'

export type ResourceSessionCleanupHookDependencies = {
  listSessions: () => Promise<DaemonSession[]>
  readBindings: () => ResourceSessionBindingInputs
  inspectInactiveCleanup: (ids: string[]) => Promise<PtyCleanupInspection[]>
  killInactiveSessions: (ids: string[]) => Promise<PtyInactiveCleanupResult[]>
}

export type ResourceSessionCleanupReviewApi = {
  state: ResourceSessionCleanupReviewState
  review: () => Promise<void>
  confirm: () => Promise<void>
  retry: () => Promise<void>
  close: () => void
}

function readCurrentBindings(): ResourceSessionBindingInputs {
  const state = useAppStore.getState()
  return {
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    workspaceSessionReady: state.workspaceSessionReady
  }
}

const defaultDependencies: ResourceSessionCleanupHookDependencies = {
  listSessions: () => window.api.pty.listSessions(),
  readBindings: readCurrentBindings,
  inspectInactiveCleanup: (ids) => window.api.pty.inspectInactiveCleanup(ids),
  killInactiveSessions: (ids) => window.api.pty.killInactiveSessions(ids)
}

export function useResourceSessionCleanupReview({
  onSessionsLoaded,
  dependencies = defaultDependencies
}: {
  onSessionsLoaded?: (sessions: DaemonSession[]) => void
  dependencies?: ResourceSessionCleanupHookDependencies
} = {}): ResourceSessionCleanupReviewApi {
  const [state, setState] = useState<ResourceSessionCleanupReviewState>({ phase: 'closed' })
  const mountedRef = useMountedRef()
  const operationGenerationRef = useRef(0)

  const listCurrentSessions = useCallback(async (): Promise<DaemonSession[]> => {
    const sessions = await dependencies.listSessions()
    if (mountedRef.current) {
      onSessionsLoaded?.(sessions)
    }
    return sessions
  }, [dependencies, mountedRef, onSessionsLoaded])

  const runReview = useCallback(async (): Promise<void> => {
    const generation = ++operationGenerationRef.current
    setState({ phase: 'reviewing' })
    try {
      const review = await reviewResourceSessionCleanup({
        listSessions: listCurrentSessions,
        readBindings: dependencies.readBindings,
        inspectInactiveCleanup: dependencies.inspectInactiveCleanup
      })
      if (mountedRef.current && operationGenerationRef.current === generation) {
        setState({ phase: 'ready', review })
      }
    } catch (error) {
      if (mountedRef.current && operationGenerationRef.current === generation) {
        setState({
          phase: 'error',
          operation: 'review',
          message: error instanceof Error ? error.message : 'Unable to review terminal sessions.'
        })
      }
    }
  }, [dependencies, listCurrentSessions, mountedRef])

  const runCleanup = useCallback(
    async (review: ResourceSessionCleanupReview): Promise<void> => {
      const generation = ++operationGenerationRef.current
      setState({ phase: 'running', review })
      try {
        const result = await executeResourceSessionCleanup(review, {
          listSessions: listCurrentSessions,
          readBindings: dependencies.readBindings,
          killInactiveSessions: dependencies.killInactiveSessions
        })
        try {
          // Why: the execution inventory is intentionally captured before the
          // guarded shutdown. Refresh once afterward so completed rows reflect
          // what the daemon actually retained rather than that pre-kill snapshot.
          await listCurrentSessions()
        } catch {
          // The per-session outcomes remain authoritative even if the optional
          // presentation refresh is temporarily unavailable.
        }
        if (mountedRef.current && operationGenerationRef.current === generation) {
          setState({ phase: 'completed', review, result })
        }
      } catch (error) {
        if (mountedRef.current && operationGenerationRef.current === generation) {
          setState({
            phase: 'error',
            operation: 'cleanup',
            message:
              error instanceof Error ? error.message : 'Unable to clean up inactive terminals.',
            review
          })
        }
      }
    },
    [dependencies, listCurrentSessions, mountedRef]
  )

  const confirm = useCallback(async (): Promise<void> => {
    if (state.phase === 'ready') {
      await runCleanup(state.review)
    } else if (state.phase === 'error' && state.operation === 'cleanup' && state.review) {
      await runCleanup(state.review)
    }
  }, [runCleanup, state])

  const retry = useCallback(async (): Promise<void> => {
    if (state.phase !== 'error') {
      return
    }
    if (state.operation === 'cleanup' && state.review) {
      await runCleanup(state.review)
      return
    }
    await runReview()
  }, [runCleanup, runReview, state])

  const close = useCallback((): void => {
    if (state.phase === 'running') {
      return
    }
    // Why: dismissal cancels only the dialog's pending review presentation;
    // confirmed cleanup stays non-cancellable and continues to settlement.
    operationGenerationRef.current += 1
    setState({ phase: 'closed' })
  }, [state.phase])

  return { state, review: runReview, confirm, retry, close }
}
