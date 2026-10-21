import type { StateCreator } from 'zustand'
import type {
  MachineExpiryWarning,
  MachineProviderSnapshot,
  MachineRecord,
  MachineTarget
} from '../../../../shared/machine-inventory'
import { machineTargetKey } from '@/lib/machines/machine-host-match'
import type { MachineChoice } from '@/lib/machines/machine-group-options'
import type { MachineCreateDraft } from '@/lib/machines/machine-create-draft'
import type { AppState } from '../types'

/** A worktree's machine wake as its terminals see it: they hold their attach until it clears. */
export type WorktreeMachineWake = {
  machineName: string
  hostId: string
  /** Plain reason the wake failed; null while it runs. */
  failure: string | null
}

export type MachinesSlice = {
  /** This app's machine providers, keyed by provider, as last pushed by main. */
  machineProviders: Readonly<Record<string, MachineProviderSnapshot>>
  /** Paired servers' machine providers, keyed by environment id. */
  machineEnvironmentProviders: Readonly<Record<string, readonly MachineProviderSnapshot[]>>
  /** Worktrees opened onto a machine that is waking, or whose wake failed, by worktree id. */
  machineWakeByWorktreeId: Readonly<Record<string, WorktreeMachineWake>>
  setWorktreeMachineWake: (worktreeId: string, wake: WorktreeMachineWake | null) => void
  /** The machine a composer had chosen when sign-in closed it; read once when it reopens. */
  composerMachineRestore: MachineChoice | null
  setComposerMachineRestore: (choice: MachineChoice | null) => void
  /** The new-machine draft a composer had when sign-in closed it; read once when it reopens. */
  composerDraftRestore: MachineCreateDraft | null
  setComposerDraftRestore: (draft: MachineCreateDraft | null) => void
  /** The machine whose Delete dialog is open; one dialog host serves every menu. */
  machineDeleteTarget: MachineTarget | null
  /** Whether the sidebar's "Archived machines (n)" row is open; closed by default. */
  archivedMachinesExpanded: boolean
  setArchivedMachinesExpanded: (expanded: boolean) => void
  setMachineDeleteTarget: (target: MachineTarget | null) => void
  applyMachineSnapshot: (snapshot: MachineProviderSnapshot) => void
  /** Main's full provider list: reported ones apply as pushes do, unreported ones are gone. */
  replaceMachineSnapshots: (snapshots: readonly MachineProviderSnapshot[]) => void
  /** Main's 15-minute warnings, keyed by `machineTargetKey`; the latest per machine wins. */
  machineExpiryWarnings: Readonly<Record<string, MachineExpiryWarning>>
  applyMachineExpiryWarning: (warning: MachineExpiryWarning) => void
  setMachineEnvironmentSnapshots: (
    environmentId: string,
    snapshots: readonly MachineProviderSnapshot[]
  ) => void
  /** A record a paired server returned from an action replaces its row there. */
  applyEnvironmentMachine: (environmentId: string, machine: MachineRecord) => void
}

/** A snapshot replaces the held one only when it is at least as fresh. */
function isNewer(
  next: MachineProviderSnapshot,
  held: MachineProviderSnapshot | undefined
): boolean {
  return !held || (next.listedAt ?? 0) >= (held.listedAt ?? 0)
}

/** A healthy re-list that changed nothing keeps the held object, so nothing re-renders. */
function changesNothing(
  next: MachineProviderSnapshot,
  held: MachineProviderSnapshot | undefined
): boolean {
  return (
    held !== undefined &&
    !next.lastFailure &&
    JSON.stringify({ ...next, listedAt: 0 }) === JSON.stringify({ ...held, listedAt: 0 })
  )
}

/** Warnings whose machine is still listed and not gone; the same object when none dropped. */
function liveExpiryWarnings(
  warnings: Readonly<Record<string, MachineExpiryWarning>>,
  providers: Readonly<Record<string, MachineProviderSnapshot>>
): Readonly<Record<string, MachineExpiryWarning>> {
  const kept = Object.entries(warnings).filter(([, warning]) =>
    providers[warning.providerKey]?.machines.some(
      (machine) => machine.id === warning.machineId && machine.state !== 'gone'
    )
  )
  return kept.length === Object.keys(warnings).length ? warnings : Object.fromEntries(kept)
}

/** New providers, with expiry warnings for machines no longer there cleared alongside. */
function withProviders(
  state: AppState,
  machineProviders: Readonly<Record<string, MachineProviderSnapshot>>
): Pick<AppState, 'machineProviders' | 'machineExpiryWarnings'> {
  return {
    machineProviders,
    machineExpiryWarnings: liveExpiryWarnings(state.machineExpiryWarnings, machineProviders)
  }
}

export const createMachinesSlice: StateCreator<AppState, [], [], MachinesSlice> = (set) => ({
  machineProviders: {},
  machineEnvironmentProviders: {},
  machineWakeByWorktreeId: {},
  setWorktreeMachineWake: (worktreeId, wake) =>
    set((state) => {
      const next = { ...state.machineWakeByWorktreeId }
      if (wake) {
        next[worktreeId] = wake
      } else {
        delete next[worktreeId]
      }
      return { machineWakeByWorktreeId: next }
    }),
  composerMachineRestore: null,
  composerDraftRestore: null,
  setComposerDraftRestore: (composerDraftRestore) => set({ composerDraftRestore }),
  setComposerMachineRestore: (composerMachineRestore) => set({ composerMachineRestore }),
  machineDeleteTarget: null,
  archivedMachinesExpanded: false,
  setArchivedMachinesExpanded: (archivedMachinesExpanded) => set({ archivedMachinesExpanded }),
  setMachineDeleteTarget: (machineDeleteTarget) => set({ machineDeleteTarget }),
  applyMachineSnapshot: (snapshot) =>
    set((state) =>
      isNewer(snapshot, state.machineProviders[snapshot.providerKey]) &&
      !changesNothing(snapshot, state.machineProviders[snapshot.providerKey])
        ? withProviders(state, { ...state.machineProviders, [snapshot.providerKey]: snapshot })
        : {}
    ),
  replaceMachineSnapshots: (snapshots) =>
    set((state) => {
      const next: Record<string, MachineProviderSnapshot> = {}
      let changed = Object.keys(state.machineProviders).length !== snapshots.length
      for (const snapshot of snapshots) {
        const held = state.machineProviders[snapshot.providerKey]
        const keep = held && (!isNewer(snapshot, held) || changesNothing(snapshot, held))
        next[snapshot.providerKey] = keep ? held : snapshot
        changed ||= !keep
      }
      return changed ? withProviders(state, next) : {}
    }),
  machineExpiryWarnings: {},
  applyMachineExpiryWarning: (warning) =>
    set((state) => ({
      machineExpiryWarnings: {
        ...state.machineExpiryWarnings,
        [machineTargetKey(warning)]: warning
      }
    })),
  setMachineEnvironmentSnapshots: (environmentId, snapshots) =>
    set((state) => {
      const held = state.machineEnvironmentProviders[environmentId]
      const unchanged =
        held?.length === snapshots.length &&
        snapshots.every((snapshot, index) => changesNothing(snapshot, held[index]))
      return unchanged
        ? {}
        : {
            machineEnvironmentProviders: {
              ...state.machineEnvironmentProviders,
              [environmentId]: snapshots
            }
          }
    }),
  applyEnvironmentMachine: (environmentId, machine) =>
    set((state) => {
      const held = state.machineEnvironmentProviders[environmentId]
      if (!held?.some((snapshot) => snapshot.providerKey === machine.providerKey)) {
        return {}
      }
      return {
        machineEnvironmentProviders: {
          ...state.machineEnvironmentProviders,
          [environmentId]: held.map((snapshot) =>
            snapshot.providerKey === machine.providerKey
              ? {
                  ...snapshot,
                  machines: snapshot.machines.map((row) => (row.id === machine.id ? machine : row))
                }
              : snapshot
          )
        }
      }
    })
})
