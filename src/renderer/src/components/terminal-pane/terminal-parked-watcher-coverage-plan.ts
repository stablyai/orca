import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import type { TerminalProviderSnapshotCapabilityState } from '../terminal/terminal-provider-snapshot-capability'
import {
  isSnapshotBackedTerminalPty,
  type TerminalParkRestorePolicy
} from './terminal-hidden-view-parking'
import {
  normalizeParkedTerminalPaneMaterialBindings,
  type ParkableTerminalTabModel,
  type ParkedTerminalPaneMaterialBinding
} from './terminal-parked-watcher-reconciliation'

export type TerminalParkedWatcherPlanGeneration = number | null
export type TerminalParkedWatcherCoverageIssueReason =
  | 'pane-model-pending'
  | 'pane-pty-pending'
  | 'invalid-leaf-id'
  | 'duplicate-leaf-binding'
  | 'duplicate-pty-binding'
  | 'pty-not-restorable'
  | 'ssh-parking-disabled'
  | 'paired-runtime-unavailable'
  | 'provider-capability-pending'
  | 'provider-snapshot-unavailable'
  | 'pty-ineligible'

export type TerminalParkedWatcherCoverageIssue = {
  reason: TerminalParkedWatcherCoverageIssueReason
  leafId?: string
  ptyId?: string | null
}

type TerminalParkedWatcherCoveragePlanBase = {
  materialKey: string
  worktreeId: string
  tabId: string
  tabPtyId: string | null
  generation: TerminalParkedWatcherPlanGeneration
  panes: readonly ParkedTerminalPaneMaterialBinding[]
}

export type TerminalParkedWatcherPendingPlan = TerminalParkedWatcherCoveragePlanBase & {
  status: 'pending'
  issue: TerminalParkedWatcherCoverageIssue
}

export type TerminalParkedWatcherBlockedPlan = TerminalParkedWatcherCoveragePlanBase & {
  status: 'blocked'
  issue: TerminalParkedWatcherCoverageIssue
}

export type TerminalParkedWatcherCoveredPlan = TerminalParkedWatcherCoveragePlanBase & {
  status: 'covered'
}

export type TerminalParkedWatcherCoveragePlan =
  | TerminalParkedWatcherPendingPlan
  | TerminalParkedWatcherBlockedPlan
  | TerminalParkedWatcherCoveredPlan

export type ParkedTerminalPtyEligibility = (ptyId: string) => boolean

type TerminalParkedWatcherPtyCoverage =
  | { status: 'covered'; authority: string }
  | { status: 'pending'; reason: TerminalParkedWatcherCoverageIssueReason }
  | { status: 'blocked'; reason: TerminalParkedWatcherCoverageIssueReason }

type EvaluatedPane = {
  pane: ParkedTerminalPaneMaterialBinding
  coverage: TerminalParkedWatcherPtyCoverage
}

function resolveTerminalParkedWatcherPtyCoverage(args: {
  ptyId: string
  worktreeId: string
  restorePolicy: TerminalParkRestorePolicy
  providerSnapshotCapability: (ptyId: string) => TerminalProviderSnapshotCapabilityState
  isPtyEligible?: ParkedTerminalPtyEligibility
}): TerminalParkedWatcherPtyCoverage {
  const ssh = parseAppSshPtyId(args.ptyId)
  let coverage: TerminalParkedWatcherPtyCoverage
  if (ssh) {
    coverage =
      args.restorePolicy.sshParkingEnabled === true
        ? { status: 'covered', authority: `ssh:${ssh.connectionId}` }
        : { status: 'blocked', reason: 'ssh-parking-disabled' }
  } else if (isRemoteRuntimePtyId(args.ptyId)) {
    const environmentId = getRemoteRuntimePtyEnvironmentId(args.ptyId)
    coverage =
      environmentId !== null &&
      args.restorePolicy.pairedRuntimeParkingEnvironmentIds?.has(environmentId) === true
        ? { status: 'covered', authority: `paired-runtime:${environmentId}` }
        : { status: 'blocked', reason: 'paired-runtime-unavailable' }
  } else if (!isSnapshotBackedTerminalPty(args.ptyId, args.worktreeId)) {
    coverage = { status: 'blocked', reason: 'pty-not-restorable' }
  } else {
    const capability = args.providerSnapshotCapability(args.ptyId)
    coverage =
      capability === 'pending'
        ? { status: 'pending', reason: 'provider-capability-pending' }
        : capability === 'authoritative'
          ? { status: 'covered', authority: 'local-provider-snapshot' }
          : { status: 'blocked', reason: 'provider-snapshot-unavailable' }
  }
  if (coverage.status === 'covered' && args.isPtyEligible?.(args.ptyId) === false) {
    return { status: 'blocked', reason: 'pty-ineligible' }
  }
  return coverage
}

function evaluatePane(args: {
  pane: ParkedTerminalPaneMaterialBinding
  leafCounts: ReadonlyMap<string, number>
  ptyCounts: ReadonlyMap<string, number>
  worktreeId: string
  restorePolicy: TerminalParkRestorePolicy
  providerSnapshotCapability: (ptyId: string) => TerminalProviderSnapshotCapabilityState
  isPtyEligible?: ParkedTerminalPtyEligibility
}): EvaluatedPane {
  const { pane } = args
  if (!isTerminalLeafId(pane.leafId)) {
    return { pane, coverage: { status: 'blocked', reason: 'invalid-leaf-id' } }
  }
  if ((args.leafCounts.get(pane.leafId) ?? 0) > 1) {
    return { pane, coverage: { status: 'blocked', reason: 'duplicate-leaf-binding' } }
  }
  if (pane.ptyId === null) {
    return { pane, coverage: { status: 'pending', reason: 'pane-pty-pending' } }
  }
  if ((args.ptyCounts.get(pane.ptyId) ?? 0) > 1) {
    return { pane, coverage: { status: 'blocked', reason: 'duplicate-pty-binding' } }
  }
  return {
    pane,
    coverage: resolveTerminalParkedWatcherPtyCoverage({
      ptyId: pane.ptyId,
      worktreeId: args.worktreeId,
      restorePolicy: args.restorePolicy,
      providerSnapshotCapability: args.providerSnapshotCapability,
      ...(args.isPtyEligible ? { isPtyEligible: args.isPtyEligible } : {})
    })
  }
}

function coverageMaterialRow({ pane, coverage }: EvaluatedPane): readonly unknown[] {
  return [
    pane.leafId,
    pane.ptyId,
    coverage.status,
    coverage.status === 'covered' ? coverage.authority : coverage.reason
  ]
}

export function createTerminalParkedWatcherCoveragePlan(args: {
  worktreeId: string
  tab: ParkableTerminalTabModel
  panes: readonly ParkedTerminalPaneMaterialBinding[]
  restorePolicy: TerminalParkRestorePolicy
  providerSnapshotCapability: (ptyId: string) => TerminalProviderSnapshotCapabilityState
  generation?: TerminalParkedWatcherPlanGeneration
  isPtyEligible?: ParkedTerminalPtyEligibility
}): TerminalParkedWatcherCoveragePlan {
  const panes = normalizeParkedTerminalPaneMaterialBindings(args.panes)
  const leafCounts = new Map<string, number>()
  const ptyCounts = new Map<string, number>()
  for (const pane of panes) {
    leafCounts.set(pane.leafId, (leafCounts.get(pane.leafId) ?? 0) + 1)
    if (pane.ptyId !== null) {
      ptyCounts.set(pane.ptyId, (ptyCounts.get(pane.ptyId) ?? 0) + 1)
    }
  }
  const evaluated = panes.map((pane) =>
    evaluatePane({
      pane,
      leafCounts,
      ptyCounts,
      worktreeId: args.worktreeId,
      restorePolicy: args.restorePolicy,
      providerSnapshotCapability: args.providerSnapshotCapability,
      ...(args.isPtyEligible ? { isPtyEligible: args.isPtyEligible } : {})
    })
  )
  const generation = args.generation ?? args.tab.generation ?? null
  const base: TerminalParkedWatcherCoveragePlanBase = {
    materialKey: JSON.stringify([
      'terminal-parked-watcher-plan-v1',
      args.worktreeId,
      args.tab.id,
      args.tab.ptyId,
      generation,
      evaluated.map(coverageMaterialRow)
    ]),
    worktreeId: args.worktreeId,
    tabId: args.tab.id,
    tabPtyId: args.tab.ptyId,
    generation,
    panes
  }
  if (panes.length === 0) {
    return { ...base, status: 'pending', issue: { reason: 'pane-model-pending' } }
  }
  const blocked = evaluated.find((entry) => entry.coverage.status === 'blocked')
  if (blocked?.coverage.status === 'blocked') {
    return {
      ...base,
      status: 'blocked',
      issue: { ...blocked.pane, reason: blocked.coverage.reason }
    }
  }
  const pending = evaluated.find((entry) => entry.coverage.status === 'pending')
  if (pending?.coverage.status === 'pending') {
    return {
      ...base,
      status: 'pending',
      issue: { ...pending.pane, reason: pending.coverage.reason }
    }
  }
  return { ...base, status: 'covered' }
}
