export const REMOTE_ARTIFACT_INPUT_ENV = 'ORCA_REMOTE_ARTIFACT_INPUT'

export function sshArtifactSourceKey(targetId: string, sourceKey: string): string {
  return JSON.stringify(['ssh', targetId, sourceKey])
}

export type RemoteArtifactInput = {
  sourceKey: string
  fileName: string
  contentType?: 'text/html' | 'text/markdown'
}

export function normalizeRemoteArtifactInput(value: unknown): RemoteArtifactInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Partial<RemoteArtifactInput>
  if (
    typeof input.sourceKey !== 'string' ||
    !input.sourceKey ||
    typeof input.fileName !== 'string' ||
    !input.fileName ||
    (input.contentType !== undefined && !['text/html', 'text/markdown'].includes(input.contentType))
  ) {
    return null
  }
  return input as RemoteArtifactInput
}

export function parseRemoteArtifactInput(value: string | undefined): RemoteArtifactInput | null {
  if (!value) {
    return null
  }
  try {
    return normalizeRemoteArtifactInput(JSON.parse(value))
  } catch {
    return null
  }
}
