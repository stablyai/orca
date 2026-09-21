import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import { revokeCustomPetBlobUrl } from '../../../components/pet/pet-blob-cache'
import { DEFAULT_PET_ID } from '../../../components/pet/pet-models'
import {
  PET_SIZE_DEFAULT,
  PET_SIZE_MAX,
  PET_SIZE_MIN,
  type CustomPet
} from '../../../../../shared/pet-types'
import { clampPetSize } from './ui-slice-hydration-sanitizers'

export function createUiSurfaceActions(set: UISliceSet, _get: UISliceGet): Partial<UISlice> {
  return {
    workspacePortScan: null,
    workspacePortScansByKey: {},
    workspacePortScanRefreshing: false,
    setWorkspacePortScan: (scan) =>
      set((state) => {
        if (!scan) {
          if (!state.workspacePortScan && Object.keys(state.workspacePortScansByKey).length === 0) {
            return state
          }
          return { workspacePortScan: null, workspacePortScansByKey: {} }
        }
        if (
          state.workspacePortScan?.key === scan.key &&
          state.workspacePortScan.result === scan.result &&
          state.workspacePortScansByKey[scan.key] === scan.result
        ) {
          return state
        }
        return {
          workspacePortScan: scan,
          workspacePortScansByKey: { ...state.workspacePortScansByKey, [scan.key]: scan.result }
        }
      }),
    // Why: target changes rebuild the aggregate without republishing or clearing per-host scans.
    setWorkspacePortScanProjection: (scan) =>
      set((state) => {
        if (
          state.workspacePortScan?.key === scan?.key &&
          state.workspacePortScan?.result === scan?.result
        ) {
          return state
        }
        return { workspacePortScan: scan }
      }),
    // Why: drop stale per-host scans in one store update so a large host set can't fan out notifications to every subscriber.
    replaceWorkspacePortScans: (scansByKey, projection) =>
      set((state) => {
        if (
          state.workspacePortScansByKey === scansByKey &&
          state.workspacePortScan?.key === projection?.key &&
          state.workspacePortScan?.result === projection?.result
        ) {
          return state
        }
        return { workspacePortScansByKey: scansByKey, workspacePortScan: projection }
      }),
    setWorkspacePortScanForKey: (key, result) =>
      set((state) => {
        const currentResult = state.workspacePortScansByKey[key]
        if (currentResult === result || (!result && !currentResult)) {
          return state
        }
        const nextScansByKey = { ...state.workspacePortScansByKey }
        if (result) {
          nextScansByKey[key] = result
        } else {
          delete nextScansByKey[key]
        }
        return {
          workspacePortScansByKey: nextScansByKey,
          workspacePortScan:
            state.workspacePortScan?.key === key
              ? result
                ? { key, result }
                : null
              : state.workspacePortScan
        }
      }),
    setWorkspacePortScanRefreshing: (refreshing) =>
      set({ workspacePortScanRefreshing: refreshing }),

    // Why: default true so enabling experimentalPet shows the pet immediately (persisted; "Hide pet" flips it false).
    petVisible: true,
    setPetVisible: (v) => {
      window.api.ui.set({ petVisible: v }).catch(console.error)
      set({ petVisible: v })
    },

    petId: DEFAULT_PET_ID,
    setPetId: (id) => {
      window.api.ui.set({ petId: id }).catch(console.error)
      set({ petId: id })
    },

    petSize: PET_SIZE_DEFAULT,
    setPetSize: (size) => {
      const clamped = clampPetSize(size, {
        min: PET_SIZE_MIN,
        max: PET_SIZE_MAX,
        fallback: PET_SIZE_DEFAULT
      })
      window.api.ui.set({ petSize: clamped }).catch(console.error)
      set({ petSize: clamped })
    },

    customPets: [],
    addCustomPet: (model) =>
      set((s) => {
        const next = [...s.customPets.filter((m) => m.id !== model.id), model]
        window.api.ui.set({ customPets: next }).catch(console.error)
        return { customPets: next }
      }),
    removeCustomPet: (id) =>
      set((s) => {
        const target = s.customPets.find((m) => m.id === id)
        if (!target) {
          return s
        }
        const next = s.customPets.filter((m) => m.id !== id)
        // Why: removing the active custom pet falls back to bundled default so the overlay isn't empty.
        const fallback = s.petId === id ? DEFAULT_PET_ID : s.petId
        // Why: single combined IPC update so customPets and petId persist atomically.
        const ipcPayload: { customPets: CustomPet[]; petId?: string } = {
          customPets: next
        }
        if (fallback !== s.petId) {
          ipcPayload.petId = fallback
        }
        window.api.ui.set(ipcPayload).catch(console.error)
        // Why: revoke the cached blob: URL so the Blob is released, not leaked for the session.
        revokeCustomPetBlobUrl(id)
        // Why: best-effort delete — bytes owned by main; fresh-UUID imports mean an orphaned file is never re-referenced.
        window.api.pet.delete(id, target.fileName, target.kind).catch(console.error)
        const partial: Partial<UISlice> = { customPets: next }
        if (fallback !== s.petId) {
          partial.petId = fallback
        }
        return partial
      }),

    pendingRevealWorktree: null,
    pendingRevealSidebarRow: null,
    // Why sidebarBody here: the worktree list (and its reveal consumer) is unmounted while the
    // Agents body is showing, so a reveal that does not switch bodies silently no-ops.
    revealWorktreeInSidebar: (worktreeId, options) =>
      set({
        sidebarBody: 'workspaces',
        pendingRevealWorktree: {
          worktreeId,
          ...(options?.executionHostId ? { executionHostId: options.executionHostId } : {}),
          behavior: options?.behavior ?? 'smooth',
          ...(options?.highlight ? { highlight: true } : {}),
          ...(options?.beginRename ? { beginRename: true } : {})
        }
      }),
    revealSidebarRow: (rowKey, options) =>
      set({
        sidebarBody: 'workspaces',
        pendingRevealSidebarRow: {
          rowKey,
          behavior: options?.behavior ?? 'smooth',
          ...(options?.highlight === false ? {} : { highlight: true })
        }
      }),
    clearPendingRevealWorktreeId: () => set({ pendingRevealWorktree: null }),
    clearPendingRevealSidebarRow: () => set({ pendingRevealSidebarRow: null }),
    scrollToDiffCommentId: null,
    setScrollToDiffCommentId: (id) => set({ scrollToDiffCommentId: id })
  }
}
