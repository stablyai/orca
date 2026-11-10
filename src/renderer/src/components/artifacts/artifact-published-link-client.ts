import type {
  ArtifactCloudOperation,
  ArtifactPublishedLink
} from '../../../../shared/artifacts/artifacts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

const LOCAL_RUNTIME = { kind: 'local' } as const

export async function getPublishedArtifactLink(sourceKey: string): Promise<string | null> {
  const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactPublishedLink | null>>(
    LOCAL_RUNTIME,
    'artifacts.getPublishedLink',
    { sourceKey }
  )
  if (result.status === 'ok') {
    return result.value?.shareUrl ?? null
  }
  throw new Error(result.status)
}
