import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type NativeChatAccountUsageModalRequest = {
  /** The chat `/usage` was typed in; the modal reads the account that chat runs on. */
  sessionId: string
  target: RuntimeClientTarget
}

export function openNativeChatAccountUsageModal(request: NativeChatAccountUsageModalRequest): void {
  useAppStore.getState().openModal('chat-account-usage', {
    sessionId: request.sessionId,
    target: request.target
  })
}

export function readNativeChatAccountUsageModalRequest(
  data: Record<string, unknown>
): NativeChatAccountUsageModalRequest | null {
  const { sessionId, target } = data
  if (typeof sessionId !== 'string' || typeof target !== 'object' || target === null) {
    return null
  }
  if ('kind' in target && target.kind === 'local') {
    return { sessionId, target: { kind: 'local' } }
  }
  if (
    'kind' in target &&
    target.kind === 'environment' &&
    'environmentId' in target &&
    typeof target.environmentId === 'string'
  ) {
    return { sessionId, target: { kind: 'environment', environmentId: target.environmentId } }
  }
  return null
}
