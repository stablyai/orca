import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import type {
  RuntimeMaestroWorkspaceCanvasMutation,
  RuntimeMaestroWorkspaceCanvasQueryResult,
  RuntimeMaestroWorkspaceCanvasScope
} from '../../../shared/runtime-types'
import {
  getRuntimeMaestroWorkspaceCanvas,
  mutateRuntimeMaestroWorkspaceCanvas
} from '@/runtime/runtime-maestro-workspace-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import {
  INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE,
  reconcileMaestroWorkspaceCanvasMutation,
  reconcileMaestroWorkspaceCanvasQuery,
  type MaestroWorkspaceCanvasState
} from '@/lib/maestro-workspace-reconciliation'

type MutationInput = RuntimeMaestroWorkspaceCanvasMutation extends infer Mutation
  ? Mutation extends RuntimeMaestroWorkspaceCanvasMutation
    ? Omit<
        Mutation,
        'scope' | 'actor_id' | 'expected_authority_revision' | 'expected_canvas_revision'
      >
    : never
  : never

type AvailableWorkspaceCanvas = Extract<
  RuntimeMaestroWorkspaceCanvasQueryResult,
  { status: 'available' }
>

const CANVAS_REVISION_ACTIONS = new Set<RuntimeMaestroWorkspaceCanvasMutation['action']>([
  'focus',
  'close',
  'update-annotation',
  'set-placement',
  'set-viewport',
  'create-manual-link',
  'delete-manual-link',
  'decide-suggestion'
])

function buildMutationRequest(
  input: MutationInput,
  scope: RuntimeMaestroWorkspaceCanvasScope,
  current: AvailableWorkspaceCanvas
): RuntimeMaestroWorkspaceCanvasMutation {
  const requiresCanvasRevision =
    CANVAS_REVISION_ACTIONS.has(input.action) ||
    (input.action === 'create' && (input.surface_type === 'content' || input.placement != null))
  return {
    ...input,
    scope,
    actor_id: current.actor_id,
    expected_authority_revision: current.snapshot.authority_revision,
    ...(requiresCanvasRevision ? { expected_canvas_revision: current.canvas.revision } : {})
  } as RuntimeMaestroWorkspaceCanvasMutation
}

function matchesScope(
  current: AvailableWorkspaceCanvas,
  scope: RuntimeMaestroWorkspaceCanvasScope
): boolean {
  return (
    current.snapshot.execution_host_id === scope.execution_host_id &&
    current.snapshot.workspace_key === scope.workspace_key
  )
}

export type MaestroWorkspaceCanvasResource = MaestroWorkspaceCanvasState & {
  refresh: () => Promise<void>
  mutate: (mutation: MutationInput) => Promise<void>
}

export function useMaestroWorkspaceCanvas(
  target: RuntimeClientTarget | null,
  scope: RuntimeMaestroWorkspaceCanvasScope | null
): MaestroWorkspaceCanvasResource {
  const [state, setState] = useState(INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE)
  const stateRef = useRef(state)
  const requestSequence = useRef(0)
  const appliedSequence = useRef(0)
  const mutationQueue = useRef<Promise<void> | null>(null)
  const identityRef = useRef('')
  const generationRef = useRef(0)
  const activeGenerationRef = useRef<number | null>(null)
  const identity = `${target?.kind ?? 'none'}:${target?.kind === 'environment' ? target.environmentId : ''}:${scope?.execution_host_id ?? ''}:${scope?.workspace_key ?? ''}`
  if (identityRef.current !== identity) {
    identityRef.current = identity
    generationRef.current += 1
    requestSequence.current = 0
    appliedSequence.current = 0
    mutationQueue.current = null
  }
  const renderGeneration = generationRef.current
  stateRef.current = state

  const applyState = useCallback(
    (update: (current: MaestroWorkspaceCanvasState) => MaestroWorkspaceCanvasState): void => {
      const next = update(stateRef.current)
      stateRef.current = next
      startTransition(() => setState(next))
    },
    []
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!target || !scope) {
      applyState((current) => ({
        ...current,
        status: 'unavailable',
        unavailableReason: 'scope-unavailable'
      }))
      return
    }
    const generation = renderGeneration
    const sequence = ++requestSequence.current
    const incoming = await getRuntimeMaestroWorkspaceCanvas(target, scope)
    if (generation !== generationRef.current) {
      return
    }
    if (sequence < appliedSequence.current) {
      return
    }
    appliedSequence.current = sequence
    applyState((current) => reconcileMaestroWorkspaceCanvasQuery(current, incoming))
  }, [applyState, renderGeneration, scope, target])

  useEffect(() => {
    let active = true
    let polling = false
    const generation = renderGeneration
    activeGenerationRef.current = generation
    applyState(() => INITIAL_MAESTRO_WORKSPACE_CANVAS_STATE)
    const poll = async (): Promise<void> => {
      if (!target || !scope || polling) {
        return
      }
      polling = true
      const sequence = ++requestSequence.current
      try {
        const incoming = await getRuntimeMaestroWorkspaceCanvas(target, scope)
        if (!active || generation !== generationRef.current) {
          return
        }
        if (sequence >= appliedSequence.current) {
          appliedSequence.current = sequence
          applyState((current) => reconcileMaestroWorkspaceCanvasQuery(current, incoming))
        }
      } finally {
        polling = false
      }
    }
    if (!target || !scope) {
      applyState((current) => ({
        ...current,
        status: 'unavailable',
        unavailableReason: 'scope-unavailable'
      }))
    } else {
      void poll()
    }
    const timer = setInterval(() => void poll(), 1_500)
    return () => {
      active = false
      if (activeGenerationRef.current === generation) {
        activeGenerationRef.current = null
      }
      clearInterval(timer)
    }
  }, [applyState, renderGeneration, scope, target])

  const performMutation = useCallback(
    async (input: MutationInput): Promise<void> => {
      if (
        renderGeneration !== generationRef.current ||
        activeGenerationRef.current !== renderGeneration
      ) {
        return
      }
      const current = stateRef.current.result
      if (!target || !scope || !current || !matchesScope(current, scope)) {
        return
      }
      const generation = renderGeneration
      let mutationBase = current
      let result = await mutateRuntimeMaestroWorkspaceCanvas(
        target,
        buildMutationRequest(input, scope, mutationBase)
      )
      if (generation !== generationRef.current || activeGenerationRef.current !== generation) {
        return
      }
      for (let staleRetry = 0; result.status === 'stale' && staleRetry < 2; staleRetry += 1) {
        if (generation !== generationRef.current || activeGenerationRef.current !== generation) {
          return
        }
        const sequence = ++requestSequence.current
        const incoming = await getRuntimeMaestroWorkspaceCanvas(target, scope)
        if (
          generation !== generationRef.current ||
          activeGenerationRef.current !== generation ||
          sequence < appliedSequence.current
        ) {
          return
        }
        appliedSequence.current = sequence
        applyState((previous) => reconcileMaestroWorkspaceCanvasQuery(previous, incoming))
        if (incoming.status === 'available' && matchesScope(incoming, scope)) {
          mutationBase = incoming
          result = await mutateRuntimeMaestroWorkspaceCanvas(
            target,
            buildMutationRequest(input, scope, mutationBase)
          )
          if (generation !== generationRef.current || activeGenerationRef.current !== generation) {
            return
          }
        } else {
          break
        }
      }
      if (generation !== generationRef.current || activeGenerationRef.current !== generation) {
        return
      }
      applyState((previous) => reconcileMaestroWorkspaceCanvasMutation(previous, result))
      if (result.status === 'applied' || result.status === 'replayed') {
        await refresh()
      }
    },
    [applyState, refresh, renderGeneration, scope, target]
  )

  const mutate = useCallback(
    (input: MutationInput): Promise<void> => {
      const queued = (mutationQueue.current ?? Promise.resolve()).then(() => performMutation(input))
      mutationQueue.current = queued.catch(() => undefined)
      return queued
    },
    [performMutation]
  )

  return { ...state, refresh, mutate }
}
