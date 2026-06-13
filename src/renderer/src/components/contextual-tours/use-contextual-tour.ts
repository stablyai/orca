import { useEffect, useRef } from 'react'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import {
  hasFeatureInteraction,
  type FeatureInteractionState
} from '../../../../shared/feature-interactions'
import { useAppStore } from '@/store'

const TOUR_SOURCES = {
  'workspace-board': 'workspace_board_visible',
  'workspace-agent-sessions': 'workspace_agent_sessions_visible',
  browser: 'browser_visible',
  tasks: 'tasks_open',
  automations: 'automations_open',
  'floating-workspace': 'floating_workspace_visible',
  'workspace-creation': 'workspace_creation_visible'
} satisfies Record<ContextualTourId, string>

export type UseContextualTourOptions = {
  recordFeatureInteraction?: boolean | undefined
  featureInteractionPersisted?: Promise<void> | undefined
  wasFeaturePreviouslyInteracted?: boolean | undefined
}

export function createContextualTourInteractionSnapshot(args: {
  id: ContextualTourId
  featureInteractions: FeatureInteractionState
  recordFeatureInteraction: (id: ContextualTourId) => Promise<void>
  recordFeatureInteractionForTour: boolean
  featureInteractionPersisted?: Promise<void> | undefined
  wasFeaturePreviouslyInteracted?: boolean | undefined
}): { persisted: Promise<void>; wasPreviouslyInteracted: boolean } {
  const wasPreviouslyInteracted =
    args.wasFeaturePreviouslyInteracted ?? hasFeatureInteraction(args.featureInteractions, args.id)
  return {
    wasPreviouslyInteracted,
    persisted: args.recordFeatureInteractionForTour
      ? args.recordFeatureInteraction(args.id)
      : (args.featureInteractionPersisted ?? Promise.resolve())
  }
}

export async function shouldRequestContextualTourAfterInteraction(args: {
  id: ContextualTourId
  persisted: Promise<void>
  isCancelled: () => boolean
  getContextualToursSeenIds: () => ContextualTourId[]
}): Promise<boolean> {
  await args.persisted
  return !args.isCancelled() && !args.getContextualToursSeenIds().includes(args.id)
}

export function useContextualTour(
  id: ContextualTourId,
  enabled: boolean,
  source: string = TOUR_SOURCES[id],
  options: UseContextualTourOptions = {}
): void {
  const {
    recordFeatureInteraction: shouldRecordFeatureInteraction = true,
    featureInteractionPersisted,
    wasFeaturePreviouslyInteracted
  } = options
  const requestContextualTour = useAppStore((s) => s.requestContextualTour)
  const suppressContextualTour = useAppStore((s) => s.suppressContextualTour)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeModal = useAppStore((s) => s.activeModal)
  const activeContextualTourId = useAppStore((s) => s.activeContextualTourId)
  const activeContextualTourSource = useAppStore((s) => s.activeContextualTourSource)
  const activeContextualTourSourceDetached = useAppStore(
    (s) => s.activeContextualTourSourceDetached
  )
  const contextualToursSeenIds = useAppStore((s) => s.contextualToursSeenIds)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const contextualTourShownThisSession = useAppStore((s) => s.contextualTourShownThisSession)
  const contextualToursOnboardingVisible = useAppStore((s) => s.contextualToursOnboardingVisible)
  const contextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.contextualToursBlockingSurfaceVisible
  )
  const enabledInteractionSnapshotRef = useRef<{
    id: ContextualTourId
    source: string
    wasPreviouslyInteracted: boolean
    persisted: Promise<void>
  } | null>(null)

  useEffect(() => {
    if (!enabled || !persistedUIReady) {
      enabledInteractionSnapshotRef.current = null
      return
    }
    if (
      enabledInteractionSnapshotRef.current?.id === id &&
      enabledInteractionSnapshotRef.current.source === source
    ) {
      return
    }
    const snapshot = createContextualTourInteractionSnapshot({
      id,
      featureInteractions: useAppStore.getState().featureInteractions,
      recordFeatureInteraction,
      recordFeatureInteractionForTour: shouldRecordFeatureInteraction,
      featureInteractionPersisted,
      wasFeaturePreviouslyInteracted
    })
    enabledInteractionSnapshotRef.current = {
      id,
      source,
      // Why: recording writes featureInteractions; subscribing here would
      // retrigger this effect and repeatedly persist the same enabled source.
      wasPreviouslyInteracted: snapshot.wasPreviouslyInteracted,
      persisted: snapshot.persisted
    }
  }, [
    enabled,
    featureInteractionPersisted,
    id,
    persistedUIReady,
    recordFeatureInteraction,
    shouldRecordFeatureInteraction,
    source,
    wasFeaturePreviouslyInteracted
  ])

  useEffect(() => {
    // Why: source disable should end through the overlay so a shown tour gets
    // a cancellation outcome; the store flag also lets pre-render attempts retry.
    if (
      !enabled &&
      activeContextualTourId === id &&
      activeContextualTourSource === source &&
      !activeContextualTourSourceDetached
    ) {
      suppressContextualTour(id, source)
    }
  }, [
    activeContextualTourId,
    activeContextualTourSource,
    activeContextualTourSourceDetached,
    enabled,
    id,
    source,
    suppressContextualTour
  ])

  useEffect(() => {
    return () => {
      const state = useAppStore.getState()
      // Why: surfaces like sheets can unmount without rendering an `enabled=false`
      // pass, so suppress their active tour during cleanup too.
      if (
        state.activeContextualTourId === id &&
        state.activeContextualTourSource === source &&
        !state.activeContextualTourSourceDetached
      ) {
        state.suppressContextualTour(id, source)
      }
    }
  }, [id, source])

  useEffect(() => {
    if (
      !enabled ||
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !persistedUIReady ||
      contextualToursAutoEligible !== true ||
      contextualToursOnboardingVisible ||
      contextualToursBlockingSurfaceVisible ||
      activeContextualTourId !== null ||
      contextualTourShownThisSession ||
      contextualToursSeenIds.includes(id)
    ) {
      return
    }

    let frame: number | null = null
    let attempts = 0
    let requestPending = false
    let cancelled = false
    const request = (): void => {
      if (frame !== null || requestPending) {
        return
      }
      requestPending = true
      const snapshot = enabledInteractionSnapshotRef.current
      const persisted =
        snapshot?.id === id && snapshot.source === source ? snapshot.persisted : Promise.resolve()
      void shouldRequestContextualTourAfterInteraction({
        id,
        persisted,
        isCancelled: () => cancelled,
        getContextualToursSeenIds: () => useAppStore.getState().contextualToursSeenIds
      }).then((shouldRequest) => {
        requestPending = false
        if (!shouldRequest) {
          return
        }
        attempts += 1
        frame = window.requestAnimationFrame(() => {
          frame = null
          const latestSnapshot = enabledInteractionSnapshotRef.current
          if (useAppStore.getState().contextualToursSeenIds.includes(id)) {
            return
          }
          requestContextualTour(
            id,
            source,
            latestSnapshot?.id === id && latestSnapshot.source === source
              ? latestSnapshot.wasPreviouslyInteracted
              : hasFeatureInteraction(useAppStore.getState().featureInteractions, id)
          )
        })
      })
    }

    request()
    const timeout = window.setTimeout(request, 250)
    const observer =
      typeof MutationObserver === 'undefined' || !document.body
        ? null
        : new MutationObserver(request)
    observer?.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'data-contextual-tour-target', 'hidden', 'style']
    })
    // Why: native prompts and async surface hydration can pause or miss the
    // first target measurement; retry briefly without long-lived polling.
    const interval = window.setInterval(() => {
      if (attempts >= 20) {
        window.clearInterval(interval)
        return
      }
      request()
    }, 500)

    return () => {
      cancelled = true
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
      window.clearTimeout(timeout)
      window.clearInterval(interval)
      observer?.disconnect()
    }
  }, [
    activeContextualTourId,
    contextualToursBlockingSurfaceVisible,
    activeModal,
    contextualToursAutoEligible,
    contextualTourShownThisSession,
    contextualToursOnboardingVisible,
    contextualToursSeenIds,
    enabled,
    id,
    persistedUIReady,
    requestContextualTour,
    source
  ])
}
