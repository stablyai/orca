import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import { clearWebSessionCloseIntentsForOwner } from '../web-session-close-intent'
import { clearWebSessionFocusIntentsForOwner } from '../web-session-focus-intent'
import { clearWebSessionReorderIntentsForOwner } from '../web-session-reorder-intent'
import {
  installWindowVisibilitySubscriptionParking,
  type WindowVisibilitySubscriptionSpec
} from '../window-visibility-subscription-parking'
import { shouldSyncAllRuntimeSessionTabs } from './tracking-decisions'
import {
  getWebSessionTabsTrackingGeneration,
  clearWebSessionTabsTrackingForEnvironment
} from './tracking-lifecycle'
import { loadInitialWebSessionTabs } from './load-initial'
import { handleGlobalSessionEvent } from './global-session-events'
import { VisibilityResumeCoordinator } from './visibility-resume-coordinator'
import type { VisibilityResumeOmission, SessionTabsStreamEvent } from './state'
import type { MirroredRuntimeEnvironment } from './visibility-resume-types'
import { WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS } from './state'

type Ref<T> = { current: T }

export type GlobalSubscriptionRefs = {
  activeRuntimeEnvironmentId: Ref<string | null>
  activeRuntimeWorktreeKey: Ref<string | null>
  visibilityResumeOmissions: Ref<Map<string, VisibilityResumeOmission>>
  snapshotReceipt: Ref<
    (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number,
      runtimeId?: string
    ) => void
  >
  snapshotApply: Ref<
    (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number,
      runtimeId?: string
    ) => boolean
  >
  snapshotAccepted: Ref<
    (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number,
      runtimeId?: string
    ) => void
  >
  ownerRevisions: Ref<Map<string, number | undefined>>
}

export type GlobalSubscriptionInstallArgs = {
  runtimeSessionMirrorEnvironmentKey: string | null
  workspaceSessionReady: boolean
  refs: GlobalSubscriptionRefs
}

function parseEnvironments(value: string | null): MirroredRuntimeEnvironment[] {
  if (!value) {
    return []
  }
  return value
    .split('\u0000')
    .map((entry) => {
      const [environmentId = '', , rawGeneration = '0', rawRevision = ''] = entry.split('\u0001')
      return {
        environmentId,
        expectedEnvironmentConnectionGeneration: Number(rawGeneration),
        expectedEnvironmentPairingRevision: rawRevision === '' ? undefined : Number(rawRevision)
      }
    })
    .filter(({ environmentId }) => environmentId.trim())
}

/** Install all-worktree subscriptions and their visibility-resume coordinator. */
export function installGlobalSessionTabsSubscriptions({
  runtimeSessionMirrorEnvironmentKey,
  workspaceSessionReady,
  refs
}: GlobalSubscriptionInstallArgs): (() => void) | undefined {
  const environments = parseEnvironments(runtimeSessionMirrorEnvironmentKey)
  const ownerRevisions = new Map(
    (workspaceSessionReady ? environments : []).map(
      ({ environmentId, expectedEnvironmentPairingRevision }) =>
        [environmentId, expectedEnvironmentPairingRevision] as const
    )
  )
  const previousOwnerRevisions = refs.ownerRevisions.current
  for (const [environmentId, previousRevision] of previousOwnerRevisions) {
    if (
      !ownerRevisions.has(environmentId) ||
      ownerRevisions.get(environmentId) !== previousRevision
    ) {
      clearWebSessionTabsTrackingForEnvironment(environmentId)
    }
  }
  refs.ownerRevisions.current = ownerRevisions
  for (const [key, omission] of refs.visibilityResumeOmissions.current) {
    const previousRevision = previousOwnerRevisions.get(omission.environmentId)
    if (
      !ownerRevisions.has(omission.environmentId) ||
      (previousOwnerRevisions.has(omission.environmentId) &&
        ownerRevisions.get(omission.environmentId) !== previousRevision)
    ) {
      refs.visibilityResumeOmissions.current.delete(key)
    }
  }
  if (!workspaceSessionReady || environments.length === 0) {
    return undefined
  }

  const subscriptionSpecs: WindowVisibilitySubscriptionSpec[] = []
  const environmentIdBySpec: string[] = []
  const coordinator = new VisibilityResumeCoordinator({
    environments,
    environmentIdBySubscriptionSpec: environmentIdBySpec,
    omissions: refs.visibilityResumeOmissions.current,
    activeRuntimeWorktreeKey: () => refs.activeRuntimeWorktreeKey.current
  })
  refs.snapshotReceipt.current = coordinator.recordSnapshotReceipt.bind(coordinator)
  refs.snapshotApply.current = coordinator.shouldApplySnapshot.bind(coordinator)
  refs.snapshotAccepted.current = coordinator.recordSnapshot.bind(coordinator)

  for (const environment of environments) {
    const {
      environmentId,
      expectedEnvironmentConnectionGeneration,
      expectedEnvironmentPairingRevision
    } = environment
    if (
      !shouldSyncAllRuntimeSessionTabs({
        activeRuntimeEnvironmentId: environmentId,
        workspaceSessionReady
      })
    ) {
      continue
    }
    let requestedInitialLoad = false
    const expectedTrackingGeneration = getWebSessionTabsTrackingGeneration(environmentId)
    environmentIdBySpec.push(environmentId)
    subscriptionSpecs.push({
      subscribe: (isCurrent, { visibilityGeneration }) => {
        const awaitingVisibilityResumeInventory = { value: visibilityGeneration > 0 }
        if (!requestedInitialLoad) {
          requestedInitialLoad = true
          loadInitialWebSessionTabs({
            environmentId,
            expectedEnvironmentConnectionGeneration,
            expectedEnvironmentPairingRevision,
            expectedTrackingGeneration,
            isCurrent
          })
        }
        return window.api.runtimeEnvironments.subscribe(
          {
            selector: environmentId,
            method: 'session.tabs.subscribeAll',
            params: {},
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision
          },
          {
            onResponse: (response) => {
              if (
                !isCurrent() ||
                getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision
              ) {
                return
              }
              handleGlobalSessionEvent({
                environmentId,
                expectedEnvironmentConnectionGeneration,
                expectedEnvironmentPairingRevision,
                expectedTrackingGeneration,
                visibilityGeneration,
                isCurrent,
                event: response.ok
                  ? response.result
                  : ({ type: 'end' } satisfies SessionTabsStreamEvent),
                response,
                awaitingVisibilityResumeInventory,
                coordinator
              })
            },
            onError: (error) => {
              if (isCurrent()) {
                console.warn('[web-session-tabs-sync] global subscription error:', error.message)
              }
            }
          }
        )
      },
      onSubscribeError: (error) => {
        console.warn(
          '[web-session-tabs-sync] failed to subscribe globally:',
          error instanceof Error ? error.message : String(error)
        )
      },
      onUnsubscribeError: (error) => {
        console.warn('[web-session-tabs-sync] failed to unsubscribe globally:', error)
      }
    })
  }

  const dispose = installWindowVisibilitySubscriptionParking(subscriptionSpecs, {
    getVisibilityResumePriority: (index) =>
      environmentIdBySpec[index] === refs.activeRuntimeEnvironmentId.current ? 0 : 1,
    visibilityResumeStaggerMs: WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS,
    onVisibilityResume: ({ visibilityGeneration, restartingSpecIndexes }) =>
      coordinator.beginVisibilityResume(visibilityGeneration, restartingSpecIndexes)
  })
  return () => {
    refs.snapshotReceipt.current = () => {}
    refs.snapshotApply.current = () => true
    refs.snapshotAccepted.current = () => {}
    dispose()
    for (const { environmentId, expectedEnvironmentPairingRevision } of environments) {
      const owner = { environmentId, pairingRevision: expectedEnvironmentPairingRevision }
      clearWebSessionCloseIntentsForOwner(owner)
      clearWebSessionFocusIntentsForOwner(owner)
      clearWebSessionReorderIntentsForOwner(owner)
    }
  }
}
