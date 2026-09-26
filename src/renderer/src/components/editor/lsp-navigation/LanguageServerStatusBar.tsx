// React status surface for the language-server push (spec §6): renders the
// transient `$/progress` projection and the persistent degraded hint next to
// the editor, and is the mount point for the eviction toast (sonner, wired in
// the subscriber). Token classes only — no raw palette (STYLEGUIDE).
//
// When clangd is unavailable (reject gate) the degraded hint is the *only*
// signal the user gets that C/C++ navigation/highlighting is off — and it
// used to render as an easy-to-miss muted chip. So when the active file is a
// C/C++ source the hint upgrades to a prominent, dismissible warning banner
// with the icon and install line; everything else stays the quiet chip.
import { useState } from 'react'
import { useSyncExternalStore } from 'react'
import { TriangleAlertIcon, XIcon } from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { cn } from '@/lib/utils'
import { isNativeNavigationLanguage } from './editor-model-language-server-owner'
import {
  getLanguageServerStatus,
  subscribeLanguageServerStatus
} from './language-server-status-store'

/**
 * True when the active editor tab is a C/C++ source the native-host navigation
 * would serve — the only case where a clangd outage visibly breaks highlighting
 * and Go-to-Definition. Exported so the test can pin a fake store.
 */
export function useActiveNativeNavigationFile(): boolean {
  const activeFileId = useAppStore((s) => s.activeFileId)
  const openFiles = useAppStore((s) => s.openFiles)
  const active = activeFileId ? (openFiles.find((f) => f.id === activeFileId) ?? null) : null
  if (!active || active.mode !== 'edit') {
    return false
  }
  return isNativeNavigationLanguage(detectLanguage(active.filePath))
}

/**
 * Renders the clangd status line for the active editor surface. Empty (renders
 * nothing) when there is no progress projection and no degraded hint, so the
 * editor layout is unchanged when clangd is idle.
 */
export function LanguageServerStatusBar(): React.ReactNode {
  const state = useSyncExternalStore(subscribeLanguageServerStatus, getLanguageServerStatus)
  const nativeNavActive = useActiveNativeNavigationFile()
  // Dismiss is local React state: clearing the hint (clangd comes back) or
  // switching files resets it so the banner can reappear when relevant again.
  const [dismissed, setDismissed] = useState(false)

  if (state.degraded && nativeNavActive && !dismissed) {
    return (
      <DegradedNavigationBanner message={state.degraded} onDismiss={() => setDismissed(true)} />
    )
  }

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

/**
 * Prominent, dismissible warning banner for the clangd-missing case on a
 * C/C++ file. Surfaces the install hint verbatim (the main-process gate
 * already shapes it as an actionable line) so the user sees *why* their
 * file is uncolored and un-navigable, not just that something is off.
 */
function DegradedNavigationBanner({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}): React.ReactNode {
  return (
    <div
      role="alert"
      data-testid="language-server-degraded-banner"
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-md border border-destructive/30',
        'bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-sm max-w-[26rem]'
      )}
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1 leading-relaxed">{message}</span>
      <button
        type="button"
        aria-label="Dismiss clangd navigation notice"
        className="shrink-0 rounded-sm p-0.5 text-destructive/70 hover:text-destructive"
        onClick={onDismiss}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
