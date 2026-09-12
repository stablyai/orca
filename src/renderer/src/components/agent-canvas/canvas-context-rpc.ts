import {
  callRuntimeRpc,
  hasRuntimeRpcErrorCode,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import {
  canvasContextReceiptSchema,
  type CanvasContextSync
} from '../../../../shared/canvas-agent-context'

export async function sendCanvasContextSnapshot(
  target: RuntimeClientTarget,
  request: CanvasContextSync
) {
  const options = { timeoutMs: 8000, suppressFeatureInteraction: true }
  try {
    return canvasContextReceiptSchema.parse(
      await callRuntimeRpc(target, 'agentHooks.canvasContextSync', request, options)
    )
  } catch (error) {
    // Old hosts may replace complete snapshots, but cannot safely retain deferred identities.
    if (!hasRuntimeRpcErrorCode(error, 'method_not_found') || request.deferredBindings.length) {
      throw error
    }
    const { deferredBindings: _deferred, ...legacy } = request
    return canvasContextReceiptSchema.parse(
      await callRuntimeRpc(target, 'agentHooks.canvasContext', legacy, options)
    )
  }
}
