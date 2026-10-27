import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SshConnectionState,
  PortForwardEntry,
  UnrestoredPortForward,
  EnrichedDetectedPort,
  SshTargetSummary
} from '../../../../shared/ssh-types'
import {
  buildRemovedSshTargetCleanupPatch,
  collectSshTargetGenerations,
  sshTargetGenerationsEqual,
  sshTargetLabelsEqual
} from './ssh-target-cleanup'
import { sshConnectionStatesEqual } from './ssh-connection-state-equality'
import { createBoundedGenerationMap } from '../../lib/bounded-generation-map'

export type SshCredentialRequest = {
  requestId: string
  targetId: string
  kind: 'passphrase' | 'password' | 'keyboard-interactive'
  detail: string
  /** RFC 4256 echo flag for keyboard-interactive prompts: when true the
   * server allows the typed response to be shown. */
  echo?: boolean
}

export type SshSlice = {
  sshConnectionStates: Map<string, SshConnectionState>
  /** Hydrate labels once so components need no per-host IPC reads. */
  sshTargetLabels: Map<string, string>
  /** Registration incarnation for owner fences, independent of connectionGeneration; absent usable generation leaves the host view-only (collectSshTargetGenerations). */
  sshTargetGenerations: Map<string, number>
  /** Retain removed-target labels from re-adoption tombstones for workspaces still pinned to them. */
  removedSshTargetLabels: Map<string, string>
  /** Absence proves removal only after a target list loads, including empty; legacy servers may never hydrate. */
  sshTargetsHydrated: boolean
  sshCredentialQueue: SshCredentialRequest[]
  /** Connected-transition epoch lets failed consumers retry loads. */
  sshConnectedGeneration: number
  /** Use immutable Record updates for Zustand selector identity; per-connection forwards arrive via main push events. */
  portForwardsByConnection: Record<string, PortForwardEntry[]>
  /** Saved forwards that aren't open, keyed by connection ID, so one that can't start stays removable. */
  unrestoredPortForwardsByConnection: Record<string, UnrestoredPortForward[]>
  /** Remote listening ports enriched by main, from SSH snapshots/push events. */
  detectedPortsByConnection: Record<string, EnrichedDetectedPort[]>
  setSshConnectionState: (targetId: string, state: SshConnectionState) => void
  setSshTargetLabels: (labels: Map<string, string>) => void
  setRemovedSshTargetLabels: (labels: Record<string, string>) => void
  setSshTargetsMetadata: (targets: SshTargetSummary[]) => void
  clearRemovedSshTargetState: (targetId: string) => void
  enqueueSshCredentialRequest: (req: SshCredentialRequest) => void
  removeSshCredentialRequest: (requestId: string) => void
  setPortForwards: (targetId: string, forwards: PortForwardEntry[]) => void
  setUnrestoredPortForwards: (targetId: string, forwards: UnrestoredPortForward[]) => void
  clearPortForwards: (targetId: string) => void
  setDetectedPorts: (targetId: string, ports: EnrichedDetectedPort[]) => void
}

const localTargetConnectionGenerations = createBoundedGenerationMap(4096)

export function getLocalSshTargetConnectionGeneration(targetId: string): number {
  return localTargetConnectionGenerations.get(targetId)
}

export const createSshSlice: StateCreator<AppState, [], [], SshSlice> = (set) => ({
  sshConnectionStates: new Map(),
  sshTargetLabels: new Map(),
  sshTargetGenerations: new Map(),
  removedSshTargetLabels: new Map(),
  sshTargetsHydrated: false,
  sshCredentialQueue: [],
  sshConnectedGeneration: 0,
  portForwardsByConnection: {},
  unrestoredPortForwardsByConnection: {},
  detectedPortsByConnection: {},

  setSshConnectionState: (targetId, state) =>
    set((s) => {
      const next = new Map(s.sshConnectionStates)
      const previous = next.get(targetId)
      if (sshConnectionStatesEqual(previous, state)) {
        return s
      }
      localTargetConnectionGenerations.advance(targetId)
      next.set(targetId, state)
      const didReconnect = previous?.status !== 'connected' && state.status === 'connected'
      let blockedConnections = s.transientClearedAgentStatusConnectionIds
      if (didReconnect && targetId in blockedConnections) {
        blockedConnections = { ...blockedConnections }
        delete blockedConnections[targetId]
      }
      return {
        sshConnectionStates: next,
        sshConnectedGeneration: didReconnect
          ? s.sshConnectedGeneration + 1
          : s.sshConnectedGeneration,
        transientClearedAgentStatusConnectionIds: blockedConnections
      }
    }),

  setSshTargetLabels: (labels) => set({ sshTargetLabels: labels }),
  setRemovedSshTargetLabels: (labels) =>
    set({ removedSshTargetLabels: new Map(Object.entries(labels)) }),
  setSshTargetsMetadata: (targets) =>
    set((s) => {
      const sshTargetGenerations = collectSshTargetGenerations(targets)
      // Both maps gate the early return: a caller that first hydrated through a
      // generation-less path would otherwise be frozen out by matching labels.
      if (
        sshTargetLabelsEqual(s.sshTargetLabels, targets) &&
        sshTargetGenerationsEqual(s.sshTargetGenerations, sshTargetGenerations)
      ) {
        // An unchanged empty list still proves first hydration.
        return s.sshTargetsHydrated ? s : { sshTargetsHydrated: true }
      }
      return {
        sshTargetLabels: new Map(targets.map((target) => [target.id, target.label])),
        sshTargetGenerations,
        sshTargetsHydrated: true
      }
    }),
  clearRemovedSshTargetState: (targetId) =>
    set((s) => buildRemovedSshTargetCleanupPatch(s, targetId) ?? s),
  enqueueSshCredentialRequest: (req) =>
    set((s) => ({ sshCredentialQueue: [...s.sshCredentialQueue, req] })),
  removeSshCredentialRequest: (requestId) =>
    set((s) => ({
      sshCredentialQueue: s.sshCredentialQueue.filter((req) => req.requestId !== requestId)
    })),

  setPortForwards: (targetId, forwards) =>
    set((s) => {
      const next = { ...s.portForwardsByConnection }
      if (forwards.length > 0) {
        next[targetId] = forwards
      } else {
        delete next[targetId]
      }
      return { portForwardsByConnection: next }
    }),

  setUnrestoredPortForwards: (targetId, forwards) =>
    set((s) => {
      const next = { ...s.unrestoredPortForwardsByConnection }
      if (forwards.length > 0) {
        next[targetId] = forwards
      } else if (targetId in next) {
        delete next[targetId]
      } else {
        return s
      }
      return { unrestoredPortForwardsByConnection: next }
    }),

  clearPortForwards: (targetId) =>
    set((s) => {
      const { [targetId]: _, ...rest } = s.portForwardsByConnection
      return { portForwardsByConnection: rest }
    }),

  setDetectedPorts: (targetId, ports) =>
    set((s) => {
      const next = { ...s.detectedPortsByConnection }
      if (ports.length > 0) {
        next[targetId] = ports
      } else {
        delete next[targetId]
      }
      return { detectedPortsByConnection: next }
    })
})
