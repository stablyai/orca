import { MaestroBrowserSurfaceReceiptSchema } from '../../../../src/shared/maestro-browser-surface'
import type { MaestroScope } from './evidence'

export function buildBrowserSurfaceReceipt(params: {
  scope: MaestroScope
  runId: string
  taskId: string
  attemptId: string
  browserPageId: string
  browserUrl: string
  now: string
}) {
  return MaestroBrowserSurfaceReceiptSchema.parse({
    schema_version: 1,
    protocol: 'maestro-browser-surface/v1',
    surface_id: 'mwc-browser-surface',
    request_id: 'mwc-browser-request',
    run_id: params.runId,
    task_id: params.taskId,
    attempt_id: params.attemptId,
    agent_id: 'codex',
    owner_principal: 'mwc-codex-coordinator',
    ownership: 'harness',
    execution_host_id: params.scope.host,
    workspace_key: params.scope.workspace,
    browser_page_id: params.browserPageId,
    title: 'MWC exact Browser page',
    url: params.browserUrl,
    origin: new URL(params.browserUrl).origin,
    profile_id: null,
    requested_visibility: 'visible',
    observed_visibility: 'visible',
    viewport: { width: 1280, height: 720, device_scale_factor: 1 },
    retention: 'retain',
    state: 'active',
    focus_receipt: {
      requested: true,
      workspace_activated: true,
      exact_page_selected: true,
      native_pane_paint: 'painted',
      observed_at: params.now,
      unavailable_reason: null
    },
    evidence: {
      route_or_component: 'Maestro workspace Canvas',
      state: 'exact Browser page',
      theme: 'light',
      source_revision: 'mwc-browser-1',
      capture_mode: 'native-viewport'
    },
    evidence_receipt: null,
    release_receipt: {
      requested: false,
      outcome: 'not_requested',
      exact_page_closed: false,
      profile_affected: false,
      observed_at: null,
      reason: null
    },
    created_at: params.now,
    updated_at: params.now
  })
}
