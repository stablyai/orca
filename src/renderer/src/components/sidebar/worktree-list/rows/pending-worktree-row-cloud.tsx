import React from 'react'
import { useAppStore } from '@/store/index'
import { HostGlyph } from '@/components/host-picker/host-row-icon'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import type { Translate } from '@/i18n/use-translate'
import { vmBuildFailureSummary } from '@/components/worktree-creation/vm-build-failure-toast'
import {
  classifyVmBuildFailure,
  isAccountGate
} from '@/components/worktree-creation/vm-build-failure'

export type PendingRowCloud = {
  /** Replaces the raw error text in the status line; null keeps upstream's label. */
  errorTitle: string | null
  /** A billing or limit refusal: muted status text instead of red. */
  refused: boolean
  /** Replaces the status glyph; null keeps upstream's spinner / warning. */
  icon: React.ReactNode
}

/** Orca Cloud's look for a pending sidebar row; a no-op for every other create. */
export function usePendingRowCloud(
  entry: PendingWorktreeCreation | undefined,
  t: Translate
): PendingRowCloud {
  const repos = useAppStore((s) => s.repos)
  if (!entry || entry.request.ephemeralVmRecipe?.provider !== 'orca-cloud') {
    return { errorTitle: null, refused: false, icon: null }
  }
  const isError = entry.status === 'error'
  // An Orca Cloud refusal reads like its build-sheet card, never the raw provider text.
  const errorTitle =
    isError && entry.error
      ? (vmBuildFailureSummary(entry, entry.error, repos, t)?.title ?? null)
      : null
  // A billing or limit refusal is a precondition you can fix, not an error: muted text and an amber
  // glyph (glossary: red only for real failures, such as a clone or a sandbox failing to start).
  const refused =
    isError &&
    isAccountGate(classifyVmBuildFailure({ entry, error: entry.error ?? null, cloud: true }))
  return {
    errorTitle,
    refused,
    // The row becomes the cloud card: same glyph from the start, state on the badge.
    icon: (
      <HostGlyph
        kind="orca-cloud"
        size={12}
        // The amber tone the glyph uses for an attention state, not red.
        state={refused ? 'unresponsive' : isError ? 'failed' : 'starting'}
      />
    )
  }
}
