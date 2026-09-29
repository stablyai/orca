// Shared state between the folder-access toast (which raises it) and the fix dialog (which renders
// it), so neither has to own the other. STA-7948.

import { toast } from 'sonner'
import { create } from 'zustand'
import type { PtyManagementFolderAccessMismatch } from '../../../preload/api-types'

export const FOLDER_ACCESS_MISMATCH_NOTICE_ID = 'mac-daemon-folder-access-mismatch'

/**
 * Where a scope's notice stands. `retired` is a takedown nobody asked for — a restart, or a poll
 * that read no daemon through a reconnect blip — so the scope may raise again; `dismissed` is the
 * user's own close and is final for the session. A scope absent from the map has never been shown.
 */
export type FolderAccessNoticePhase = 'visible' | 'retired' | 'dismissed'

/** At most one, because sonner keeps a single toast under the notice's id. */
export function visibleNoticeScope(
  noticePhaseByScope: ReadonlyMap<string, FolderAccessNoticePhase>
): string | null {
  for (const [daemonScope, phase] of noticePhaseByScope) {
    if (phase === 'visible') {
      return daemonScope
    }
  }
  return null
}

type MacFolderAccessFixState = {
  /** The latest verdict main reported, whatever scope it is about. The dialog renders this one. */
  mismatch: PtyManagementFolderAccessMismatch | null
  /**
   * The scope the user asked to fix. The dialog shows only while it still matches the evidence, so
   * evidence that moves to another scope closes it rather than retargeting it mid-remedy.
   */
  openScope: string | null
  /** Every scope that has ever raised a notice, and where each one stands now. */
  noticePhaseByScope: ReadonlyMap<string, FolderAccessNoticePhase>
  openFix: () => void
  close: () => void
  /**
   * Every verdict main produces — a poll or a reset's forced re-probe — lands here unconditionally,
   * and a null one retires the notice as well, so no caller has to remember to.
   */
  applyVerdict: (mismatch: PtyManagementFolderAccessMismatch | null) => void
  showNotice: (daemonScope: string) => void
  retireNotice: (daemonScope: string) => void
  dismissNotice: (daemonScope: string) => void
}

export const useMacFolderAccessFixStore = create<MacFolderAccessFixState>()((set, get) => ({
  mismatch: null,
  openScope: null,
  noticePhaseByScope: new Map<string, FolderAccessNoticePhase>(),
  openFix: () => set((state) => ({ openScope: state.mismatch?.daemonScope ?? null })),
  close: () => set({ openScope: null }),
  applyVerdict: (mismatch) => {
    // The open remedy belongs to one scope; any other verdict ends it.
    set((state) => ({
      mismatch,
      openScope: mismatch && mismatch.daemonScope === state.openScope ? state.openScope : null
    }))
    if (mismatch) {
      return
    }
    // No evidence left, so the toast goes too — whether a poll or a reset is what found that out.
    const visible = visibleNoticeScope(get().noticePhaseByScope)
    if (visible) {
      get().retireNotice(visible)
    }
  },
  showNotice: (daemonScope) =>
    set((state) => {
      const next = new Map(state.noticePhaseByScope)
      for (const [scope, phase] of next) {
        // One toast id, so raising this scope is what takes the previous one off screen.
        if (phase === 'visible' && scope !== daemonScope) {
          next.set(scope, 'retired')
        }
      }
      return { noticePhaseByScope: next.set(daemonScope, 'visible') }
    }),
  retireNotice: (daemonScope) => {
    const { noticePhaseByScope } = get()
    if (noticePhaseByScope.get(daemonScope) !== 'visible') {
      return
    }
    // Why retire first: sonner reports a programmatic dismissal through `onDismiss` too, and only
    // a still-visible scope there is the user's doing.
    set({ noticePhaseByScope: new Map(noticePhaseByScope).set(daemonScope, 'retired') })
    toast.dismiss(FOLDER_ACCESS_MISMATCH_NOTICE_ID)
  },
  dismissNotice: (daemonScope) =>
    set((state) => ({
      noticePhaseByScope: new Map(state.noticePhaseByScope).set(daemonScope, 'dismissed')
    }))
}))
