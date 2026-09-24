// React status surface for the language-server push (spec §6): renders the
// transient `$/progress` projection and the persistent degraded hint next to
// the editor, and is the mount point for the eviction toast (sonner, wired in
// the subscriber). Token classes only — no raw palette (STYLEGUIDE).
import { useSyncExternalStore } from 'react'
import {
  getLanguageServerStatus,
  subscribeLanguageServerStatus
} from './language-server-status-store'

/**
 * Renders the clangd status line for the active editor surface. Empty (renders
 * nothing) when there is no progress projection and no degraded hint, so the
 * editor layout is unchanged when clangd is idle.
 */
export function LanguageServerStatusBar(): React.ReactNode {
  const state = useSyncExternalStore(subscribeLanguageServerStatus, getLanguageServerStatus)
  if (!state.progress && !state.degraded) {
    return null
  }
  const text = state.degraded ?? state.progress
  return (
    <span
      className="text-xs text-muted-foreground pointer-events-none select-none truncate max-w-[40vw]"
      aria-live="polite"
      data-testid="language-server-status"
    >
      {text}
    </span>
  )
}
