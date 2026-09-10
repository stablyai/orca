import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MaestroProjection } from '../../../../shared/maestro-projection'
import type {
  MaestroHumanReview,
  MaestroHumanReviewTransitionRequest
} from '../../../../shared/maestro-human-review'
import type { MaestroBrowserSurfaceReceipt } from '../../../../shared/maestro-browser-surface'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

const REVIEW_POLL_INTERVAL_MS = 1_500

export type MaestroHumanReviewResource = {
  status: 'loading' | 'ready' | 'error'
  reviews: readonly MaestroHumanReview[]
  error: string | null
  refresh: () => Promise<void>
  transition: (request: MaestroHumanReviewTransitionInput) => Promise<void>
  focusBrowser: (review: MaestroHumanReview) => Promise<void>
}

export type MaestroHumanReviewTransitionInput =
  MaestroHumanReviewTransitionRequest extends infer Request
    ? Request extends MaestroHumanReviewTransitionRequest
      ? Omit<Request, 'workspace'>
      : never
    : never

export function useMaestroHumanReview(
  target: RuntimeClientTarget,
  projection: MaestroProjection | null
): MaestroHumanReviewResource {
  const repositoryId = projection?.repositoryId
  const runId = projection?.runId
  const executionHostId = projection?.workspace.executionHostId
  const workspaceKey = projection?.workspace.workspaceKey
  const workspace = useMemo(
    () =>
      repositoryId && runId && executionHostId && workspaceKey
        ? {
            repository_id: repositoryId,
            execution_host_id: executionHostId,
            workspace_key: workspaceKey,
            run_id: runId
          }
        : null,
    [executionHostId, repositoryId, runId, workspaceKey]
  )
  const identity = workspace
    ? `${workspace.execution_host_id}\0${workspace.workspace_key}\0${workspace.run_id}`
    : 'unbound'
  const [state, setState] = useState<{
    identity: string
    status: 'loading' | 'ready' | 'error'
    reviews: readonly MaestroHumanReview[]
    error: string | null
  }>({ identity, status: 'loading', reviews: [], error: null })

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setState({ identity, status: 'loading', reviews: [], error: null })
      return
    }
    try {
      const response = await callRuntimeRpc<{ reviews: MaestroHumanReview[] }>(
        target,
        'maestro.humanReview.list',
        { workspace }
      )
      setState({ identity, status: 'ready', reviews: response.reviews, error: null })
    } catch (error) {
      setState({
        identity,
        status: 'error',
        reviews: [],
        error: error instanceof Error ? error.message : 'Human review is unavailable.'
      })
    }
  }, [identity, target, workspace])

  useEffect(() => {
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) {
        return
      }
      polling = true
      await refresh()
      polling = false
    }
    setState({ identity, status: 'loading', reviews: [], error: null })
    void poll()
    const interval = setInterval(() => void poll(), REVIEW_POLL_INTERVAL_MS)
    return () => {
      clearInterval(interval)
    }
  }, [identity, refresh])

  const transition = useCallback(
    async (request: MaestroHumanReviewTransitionInput): Promise<void> => {
      if (!workspace) {
        throw new Error('Human review has no authoritative Run binding.')
      }
      await callRuntimeRpc(target, 'maestro.humanReview.transition', { ...request, workspace })
      await refresh()
    },
    [refresh, target, workspace]
  )

  const focusBrowser = useCallback(
    async (review: MaestroHumanReview): Promise<void> => {
      const browser = review.references.browser
      if (!browser) {
        throw new Error('This review has no Browser surface.')
      }
      const receipt = await callRuntimeRpc<MaestroBrowserSurfaceReceipt>(
        target,
        'orchestration.browserSurface.focus',
        {
          schema_version: 1,
          protocol: 'maestro-browser-surface/v1',
          workspace: review.workspace,
          actor: {
            actor_id: 'canvas-human',
            kind: 'user',
            authenticated: true,
            session_id: 'canvas-human'
          },
          coordinator_generation: review.coordinator_generation,
          surface_id: browser.surface_id,
          ...(browser.profile_consent_receipt
            ? { profile_consent_receipt: browser.profile_consent_receipt }
            : {})
        }
      )
      if (
        receipt.surface_id !== browser.surface_id ||
        receipt.browser_page_id !== browser.browser_page_id
      ) {
        throw new Error('Browser Focus returned a different page than this review references.')
      }
    },
    [target]
  )

  return state.identity === identity
    ? { ...state, refresh, transition, focusBrowser }
    : { status: 'loading', reviews: [], error: null, refresh, transition, focusBrowser }
}
