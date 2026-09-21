import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { probeHostLiveTerminals } from '../host-live-terminal-probe'
import {
  markHostSessionMirrorHydrated,
  markHostSessionMirrorWorktreeHydrated
} from '../host-session-mirror-hydration'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import { getWebSessionTabsTrackingGeneration } from './tracking-lifecycle'
import type { WebSessionTabsSnapshotDecision } from './tracking-decisions'

/** Proof that the store patch committed and its host evidence may be settled. */
export type HostSessionMirrorSettle = () => void

export type HostSessionMirrorPatchFrame = {
  environmentId: string
  worktreeId: string
  decision: WebSessionTabsSnapshotDecision
  expectedEnvironmentConnectionGeneration?: number
  expectedEnvironmentPairingRevision?: number
  expectedTrackingGeneration?: number
}

export type HostSessionMirrorPatchVerdict = {
  frames: readonly HostSessionMirrorPatchFrame[]
  fullInventory?: {
    environmentId: string
    publishedSnapshotCount: number
    authoritative?: boolean
    expectedEnvironmentConnectionGeneration?: number
    expectedEnvironmentPairingRevision?: number
    expectedTrackingGeneration?: number
  }
}

type HostSessionMirrorSettleFence = {
  environmentId: string
  connectionGeneration: number
  pairingRevision?: number
  trackingGeneration: number
}

function captureHostSessionMirrorSettleFence(
  environmentId: string,
  expected: {
    connectionGeneration?: number
    pairingRevision?: number
    trackingGeneration?: number
  } = {}
): HostSessionMirrorSettleFence {
  return {
    environmentId,
    connectionGeneration:
      expected.connectionGeneration ?? getRuntimeEnvironmentConnectionGeneration(environmentId),
    pairingRevision: expected.pairingRevision ?? getRuntimeEnvironmentRevision(environmentId),
    trackingGeneration:
      expected.trackingGeneration ?? getWebSessionTabsTrackingGeneration(environmentId)
  }
}

function hostSessionMirrorSettleFenceIsCurrent(fence: HostSessionMirrorSettleFence): boolean {
  return (
    getRuntimeEnvironmentConnectionGeneration(fence.environmentId) === fence.connectionGeneration &&
    getRuntimeEnvironmentRevision(fence.environmentId) === fence.pairingRevision &&
    getWebSessionTabsTrackingGeneration(fence.environmentId) === fence.trackingGeneration
  )
}

function settleEmptyHostInventoryOnlyIfHostHasNoTerminals(
  fence: HostSessionMirrorSettleFence
): void {
  void probeHostLiveTerminals(
    fence.environmentId,
    undefined,
    fence.connectionGeneration,
    fence.pairingRevision
  ).then((verdict) => {
    // A reconnect while probing invalidates the answer for this connection.
    if (verdict === 'none' && hostSessionMirrorSettleFenceIsCurrent(fence)) {
      markHostSessionMirrorHydrated(fence.environmentId)
    }
  })
}

export function createHostSessionMirrorSettle(
  verdict: HostSessionMirrorPatchVerdict
): HostSessionMirrorSettle {
  const fenceByEnvironment = new Map<string, HostSessionMirrorSettleFence>()
  for (const frame of verdict.frames) {
    fenceByEnvironment.set(
      frame.environmentId,
      captureHostSessionMirrorSettleFence(frame.environmentId, {
        connectionGeneration: frame.expectedEnvironmentConnectionGeneration,
        pairingRevision: frame.expectedEnvironmentPairingRevision,
        trackingGeneration: frame.expectedTrackingGeneration
      })
    )
  }
  if (verdict.fullInventory) {
    fenceByEnvironment.set(
      verdict.fullInventory.environmentId,
      captureHostSessionMirrorSettleFence(verdict.fullInventory.environmentId, {
        connectionGeneration: verdict.fullInventory.expectedEnvironmentConnectionGeneration,
        pairingRevision: verdict.fullInventory.expectedEnvironmentPairingRevision,
        trackingGeneration: verdict.fullInventory.expectedTrackingGeneration
      })
    )
  }
  return () => {
    const { frames, fullInventory } = verdict
    const settles = frames.filter(({ decision }) => decision.settlesHostMirror)
    if (fullInventory && settles.length === fullInventory.publishedSnapshotCount) {
      const fence = fenceByEnvironment.get(fullInventory.environmentId)
      if (!fence || !hostSessionMirrorSettleFenceIsCurrent(fence)) {
        return
      }
      if (fullInventory.publishedSnapshotCount === 0) {
        if (fullInventory.authoritative) {
          markHostSessionMirrorHydrated(fullInventory.environmentId)
        } else {
          settleEmptyHostInventoryOnlyIfHostHasNoTerminals(fence)
        }
        return
      }
      markHostSessionMirrorHydrated(fullInventory.environmentId)
      return
    }
    for (const { environmentId, worktreeId } of settles) {
      const fence = fenceByEnvironment.get(environmentId)
      if (fence && hostSessionMirrorSettleFenceIsCurrent(fence)) {
        markHostSessionMirrorWorktreeHydrated(environmentId, worktreeId)
      }
    }
  }
}

export function hostSessionMirrorSettleForPatchlessFrame(
  decision: WebSessionTabsSnapshotDecision,
  environmentId: string,
  worktreeId: string,
  expected: {
    connectionGeneration?: number
    pairingRevision?: number
    trackingGeneration?: number
  } = {}
): HostSessionMirrorSettle | null {
  if (!decision.settlesHostMirror) {
    return null
  }
  const fence = captureHostSessionMirrorSettleFence(environmentId, expected)
  return () => {
    if (hostSessionMirrorSettleFenceIsCurrent(fence)) {
      markHostSessionMirrorWorktreeHydrated(environmentId, worktreeId)
    }
  }
}
