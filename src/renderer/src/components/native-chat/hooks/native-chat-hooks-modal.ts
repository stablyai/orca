import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

export type NativeChatHooksModalRequest = {
  sessionId: string
  target: RuntimeClientTarget
}

export function openNativeChatHooksModal(request: NativeChatHooksModalRequest): void {
  useAppStore.getState().openModal('chat-hooks', {
    sessionId: request.sessionId,
    target: request.target
  })
}

export function readNativeChatHooksModalRequest(
  data: Record<string, unknown>
): NativeChatHooksModalRequest | null {
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
