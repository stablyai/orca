import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

/** A root modal opened from a chat's composer; it acts on that chat's session on its host. */
export type NativeChatSessionModalRequest = {
  sessionId: string
  target: RuntimeClientTarget
}

export function readNativeChatSessionModalRequest(
  data: Record<string, unknown>
): NativeChatSessionModalRequest | null {
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
