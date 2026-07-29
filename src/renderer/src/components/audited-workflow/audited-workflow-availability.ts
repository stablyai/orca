// Single source of truth for whether Audited Workflow can be reachable at
// all in the current renderer. Audited Workflow is Electron-IPC-only (see
// ipc/audited-workflow.ts) — it has no web/RPC transport and the web preload
// (src/renderer/src/web/web-preload-api.ts) intentionally has no
// `auditedWorkflow` implementation. Every surface that could expose or
// activate the feature (settings toggle, sidebar entry, programmatic
// navigation, persisted-view hydration, and the top-level render switch)
// must gate on this predicate, not just on the experimental setting — the
// setting only controls whether a LOCAL Electron user opted in; it is not an
// environment check and must never be treated as one.
import { isWebClientLocation } from '@/lib/web-client-location'
import type { TopLevelView } from '../../../../shared/types'

export function isAuditedWorkflowAvailable(): boolean {
  return !isWebClientLocation()
}

/**
 * Normalizes any TopLevelView value so 'auditedWorkflow' can never reach a
 * paired web client — every other view passes through unchanged. This is the
 * single choke point every activeView write path (the generic setActiveView
 * setter, hydration, App's own read of the store) must apply, so a stray
 * 'auditedWorkflow' value from restoration/sync code can never leave the
 * main content blank in the web client (activeView === 'terminal' checks
 * elsewhere would otherwise all fail to match).
 */
export function normalizeAuditedWorkflowActiveView(view: TopLevelView): TopLevelView {
  if (view === 'auditedWorkflow' && !isAuditedWorkflowAvailable()) {
    return 'terminal'
  }
  return view
}
