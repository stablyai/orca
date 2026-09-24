// Language-server status subscriber (spec §6): decodes the discriminated-union
// `languageServers:status` push into (a) a transient `$/progress` projection,
// (b) a persistent degraded hint (version gate / install hint), and (c) a
// one-shot toast for LRU eviction. The pure store lives in
// `language-server-status-store` (no sonner, no React) so the status bar
// component can import it without a cycle; this module owns the sonner + chip.
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import type { LanguageServerStatusEvent } from '../../../../../shared/language-server-navigation-types'
import { LanguageServerStatusBar } from './LanguageServerStatusBar'
import {
  setLanguageServerDegraded,
  setLanguageServerProgress
} from './language-server-status-store'

/** Apply one pushed status event. Exported for tests. */
export function applyLanguageServerStatusEvent(event: LanguageServerStatusEvent): void {
  if (event.kind === 'progress') {
    setLanguageServerProgress(event.text)
    return
  }
  if (event.kind === 'degraded') {
    setLanguageServerDegraded(event.message)
    return
  }
  // One-shot eviction toast; leaves the store untouched.
  toast(event.message)
}

type StatusApi = {
  onStatus: (callback: (event: LanguageServerStatusEvent) => void) => () => void
}

/**
 * Subscribes to the `languageServers:status` push and routes events to the
 * store + sonner, and mounts the React status chip. Idempotent; returns an
 * uninstall function. The window api is injected so unit tests can pass a fake.
 */
export function installLanguageServerStatusSubscriber(
  api: StatusApi = window.api.languageServers
): () => void {
  const unsubscribe = api.onStatus(applyLanguageServerStatusEvent)
  const unmountChip = mountStatusChip()
  return () => {
    unsubscribe()
    unmountChip()
  }
}

/**
 * Mounts the React status bar as a small fixed chip so `$/progress` and the
 * degraded hint are visible without an editor-tree edit (the status-bar module
 * is out of scope for S2). Token classes only; the chip renders nothing when
 * there is no text (see LanguageServerStatusBar).
 */
function mountStatusChip(): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }
  const container = document.createElement('div')
  container.className =
    'fixed bottom-2 right-2 z-[var(--z-overlay,1000)] flex items-center gap-1 pointer-events-none'
  document.body.append(container)
  let root: Root | null = null
  try {
    root = createRoot(container)
    root.render(<LanguageServerStatusBar />)
  } catch {
    // Rendering must never break the editor; the toast path still works.
    container.remove()
    return () => {}
  }
  return () => {
    root?.unmount()
    container.remove()
  }
}
