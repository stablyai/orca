// The composer's side of the Orca Cloud setup page (composer-redo): the snapshot the page keeps for
// Back and for its auto-start, and the hidden composer that submits once setup is done.
import React, { useEffect, useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import type { ComposerModalData } from './composer-modal-data'

/** How long a hidden Orca Cloud auto-start may take before the dialog shows instead. */
const CLOUD_AUTO_START_REVEAL_MS = 8_000

/** The composer as it is now: prompt, project, base branch, linked item and agent pick. */
export function buildComposerSnapshot(
  modalData: ComposerModalData,
  card: {
    name: string
    repoId: string
    baseBranch?: string
    linkedWorkItem?: ComposerModalData['linkedWorkItem']
    note: string
  },
  agentPick: Omit<NonNullable<ComposerModalData['recovery']>, 'note'>
): ComposerModalData {
  return {
    ...modalData,
    prefilledName: card.name,
    initialRepoId: card.repoId,
    ...(card.baseBranch ? { initialBaseBranch: card.baseBranch } : {}),
    linkedWorkItem: card.linkedWorkItem ?? null,
    recovery: { ...agentPick, note: card.note }
  }
}

/**
 * Setup finished on its page: the composer submits with the dialog unseen. If the start can't run
 * by itself in time (a form error, a revoked grant), the dialog appears with everything kept.
 * Returns the modal data to render once visible (no second auto-start), or null while hidden.
 */
export function useCloudAutoStartReveal(modalData: ComposerModalData): ComposerModalData | null {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (!modalData.cloudAutoStart) {
      return
    }
    const timer = window.setTimeout(() => setRevealed(true), CLOUD_AUTO_START_REVEAL_MS)
    return () => window.clearTimeout(timer)
  }, [modalData.cloudAutoStart])
  if (!modalData.cloudAutoStart) {
    return modalData
  }
  return revealed ? { ...modalData, cloudAutoStart: false } : null
}

/** A closed Root still gives the title its context; nothing is portaled or shown. */
export function HiddenComposer({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Dialog open={false}>
      <div className="hidden" aria-hidden>
        {children}
      </div>
    </Dialog>
  )
}
