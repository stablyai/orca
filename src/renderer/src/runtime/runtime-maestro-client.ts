import type {
  DelegationIntent,
  MaestroDocumentAuthoringMutation,
  MaestroDocumentLayoutMutation,
  MaestroDocumentReadResult,
  MaestroDocumentReadScope,
  MaestroMutation,
  MaestroWorkspaceAnchor
} from '../../../shared/maestro-contract'
import type {
  MaestroDelegationCatalog,
  MaestroDelegationIntent,
  MaestroDelegationRequest
} from '../../../shared/maestro-delegation'
import type { MaestroProjection } from '../../../shared/maestro-projection'
import type { MaestroCanvasIndexEntry } from '../../../shared/maestro-canvas-index'
import type { MaestroBrowserSurfaceReceipt } from '../../../shared/maestro-browser-surface'
import type { BrowserScreenshotResult, BrowserTabSwitchResult } from '../../../shared/runtime-types'
import type { RuntimeResourceHealth } from '../../../shared/process-stats-types'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

export type MaestroCanvasIndexResult = { entries: MaestroCanvasIndexEntry[] }

export function getMaestroResourceHealth(
  target: RuntimeClientTarget,
  scope: { executionHostId: string; workspaceKey: string; visible?: boolean },
  signal?: AbortSignal
): Promise<RuntimeResourceHealth> {
  return callRuntimeRpc<RuntimeResourceHealth>(
    target,
    'runtime.resourceHealth',
    {
      executionHostId: scope.executionHostId,
      workspaceKey: scope.workspaceKey,
      visible: scope.visible ?? true
    },
    { signal }
  )
}

export function listMaestroCanvases(
  target: RuntimeClientTarget,
  signal?: AbortSignal
): Promise<MaestroCanvasIndexResult> {
  return callRuntimeRpc<MaestroCanvasIndexResult>(target, 'maestro.list', undefined, { signal })
}

export function getMaestroDocument(
  target: RuntimeClientTarget,
  scope: MaestroDocumentReadScope
): Promise<MaestroDocumentReadResult> {
  return callRuntimeRpc<MaestroDocumentReadResult>(target, 'maestro.document.get', { scope })
}

export function getMaestroDeltas(
  target: RuntimeClientTarget,
  workspace: MaestroWorkspaceAnchor,
  sinceRevision: number
) {
  return callRuntimeRpc(target, 'maestro.document.deltas', { workspace, sinceRevision })
}

export function getMaestroProjection(
  target: RuntimeClientTarget,
  scope: MaestroDocumentReadScope
): Promise<MaestroProjection | null> {
  return callRuntimeRpc<MaestroProjection | null>(target, 'maestro.projection.get', { scope })
}

/**
 * A workspace key is not a worktree selector, and the runtime already treats an explicit
 * page id as a stable tab identity that must not be narrowed by workspace scoping. Sending
 * one only risks resolving the exact page against the wrong workspace, or none at all.
 */
export function focusMaestroBrowserSurface(
  target: RuntimeClientTarget,
  receipt: MaestroBrowserSurfaceReceipt
): Promise<BrowserTabSwitchResult> {
  if (!receipt.browser_page_id) {
    return Promise.reject(new Error('The browser surface has no page identity.'))
  }
  return callRuntimeRpc<BrowserTabSwitchResult>(target, 'browser.tabSwitch', {
    page: receipt.browser_page_id,
    focus: true
  })
}

export function captureMaestroBrowserSurfacePreview(
  target: RuntimeClientTarget,
  receipt: MaestroBrowserSurfaceReceipt
): Promise<BrowserScreenshotResult> {
  if (!receipt.browser_page_id) {
    return Promise.reject(new Error('The browser surface has no page identity.'))
  }
  return callRuntimeRpc<BrowserScreenshotResult>(target, 'browser.screenshot', {
    page: receipt.browser_page_id,
    format: 'png'
  })
}

export function applyMaestroMutation(target: RuntimeClientTarget, mutation: MaestroMutation) {
  return callRuntimeRpc(target, 'maestro.mutation.apply', mutation)
}

export function applyMaestroDocumentLayoutMutation(
  target: RuntimeClientTarget,
  mutation: MaestroDocumentLayoutMutation
) {
  return callRuntimeRpc(target, 'maestro.document.layout.apply', mutation)
}

export function applyMaestroDocumentAuthoringMutation(
  target: RuntimeClientTarget,
  mutation: MaestroDocumentAuthoringMutation
) {
  return callRuntimeRpc(target, 'maestro.document.authoring.apply', mutation)
}

export function requestMaestroDelegation(target: RuntimeClientTarget, intent: DelegationIntent) {
  return callRuntimeRpc(target, 'maestro.intent.request', intent)
}

export function getMaestroDelegationCatalog(
  target: RuntimeClientTarget,
  workspace: MaestroWorkspaceAnchor
): Promise<MaestroDelegationCatalog> {
  return callRuntimeRpc<MaestroDelegationCatalog>(target, 'maestro.delegation.catalog', {
    workspace
  })
}

export function requestMaestroDelegationIntent(
  target: RuntimeClientTarget,
  request: MaestroDelegationRequest
): Promise<MaestroDelegationIntent> {
  return callRuntimeRpc<MaestroDelegationIntent>(target, 'maestro.delegation.request', request)
}

export function getMaestroDelegationIntent(
  target: RuntimeClientTarget,
  intentId: string,
  workspace: MaestroWorkspaceAnchor
): Promise<MaestroDelegationIntent> {
  return callRuntimeRpc<MaestroDelegationIntent>(target, 'maestro.delegation.get', {
    intent_id: intentId,
    workspace
  })
}

export function takeMaestroDelegationIntent(
  target: RuntimeClientTarget,
  intentId: string,
  workspace: MaestroWorkspaceAnchor
): Promise<MaestroDelegationIntent> {
  return callRuntimeRpc<MaestroDelegationIntent>(target, 'maestro.delegation.take', {
    intent_id: intentId,
    workspace
  })
}

export function settleMaestroDelegationIntent(
  target: RuntimeClientTarget,
  intentId: string,
  workspace: MaestroWorkspaceAnchor,
  receipt: unknown
): Promise<MaestroDelegationIntent> {
  return callRuntimeRpc<MaestroDelegationIntent>(target, 'maestro.delegation.settle', {
    intent_id: intentId,
    workspace,
    receipt
  })
}

export function getMaestroContextSnapshot(
  target: RuntimeClientTarget,
  workspace: MaestroWorkspaceAnchor,
  snapshotId: string
) {
  return callRuntimeRpc(target, 'maestro.snapshot.get', { workspace, snapshotId })
}

export function releaseMaestroContextSnapshot(
  target: RuntimeClientTarget,
  workspace: MaestroWorkspaceAnchor,
  snapshotId: string
) {
  return callRuntimeRpc(target, 'maestro.snapshot.release', { workspace, snapshotId })
}
