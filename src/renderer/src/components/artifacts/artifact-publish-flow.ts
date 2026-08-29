import { toast } from 'sonner'
import type {
  ArtifactCloudOperation,
  ArtifactPublishResult,
  ArtifactWriteRequest
} from '../../../../shared/artifacts'
import {
  ARTIFACT_CLI_MAX_RPC_BYTES,
  artifactWriteRequestByteLength
} from '../../../../shared/artifacts'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'

const LOCAL_RUNTIME = { kind: 'local' } as const

export type ArtifactPublishPreparationErrorCode =
  | 'empty'
  | 'too-large'
  | 'unreadable'
  | 'unsupported'
  | 'binary'

export class ArtifactPublishPreparationError extends Error {
  constructor(readonly code: ArtifactPublishPreparationErrorCode) {
    super(code)
  }
}

export function validateArtifactPublishRequest(
  request: ArtifactWriteRequest
): ArtifactWriteRequest {
  if (!request.content) {
    throw new ArtifactPublishPreparationError('empty')
  }
  if (artifactWriteRequestByteLength(request) > ARTIFACT_CLI_MAX_RPC_BYTES) {
    throw new ArtifactPublishPreparationError('too-large')
  }
  return request
}

export async function publishArtifactFromSurface(
  createRequest: () => Promise<ArtifactWriteRequest>
): Promise<ArtifactPublishResult | null> {
  try {
    if (!(await ensureArtifactAccountConnected())) {
      return null
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const request = validateArtifactPublishRequest(await createRequest())
      const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactPublishResult>>(
        LOCAL_RUNTIME,
        'artifacts.publish',
        request
      )
      if (result.status === 'ok') {
        showArtifactPublishedToast(result.value)
        return result.value
      }
      if (result.status === 'unconfigured') {
        toast.error(
          translate(
            'auto.components.artifacts.artifact-publish-flow.9a078a0c65',
            'Artifact sharing is unavailable'
          ),
          { description: result.message }
        )
        return null
      }
      if (attempt === 0 && (await reconnectArtifactAccount())) {
        continue
      }
      toast.error(
        translate(
          'auto.components.artifacts.artifact-publish-flow.bba20daa6d',
          'Sign in to Orca and try again.'
        )
      )
      return null
    }
  } catch (error) {
    console.error('Failed to publish artifact:', error)
    toast.error(
      translate(
        'auto.components.artifacts.artifact-publish-flow.54b1805328',
        'Could not share artifact'
      ),
      error instanceof ArtifactPublishPreparationError
        ? { description: artifactPreparationErrorDescription(error.code) }
        : undefined
    )
  }
  return null
}

async function ensureArtifactAccountConnected(): Promise<boolean> {
  const state = useAppStore.getState()
  if (state.orcaProfileAuthStatus?.state === 'connected') {
    return true
  }
  return (await state.connectCurrentOrcaProfile())?.status === 'connected'
}

async function reconnectArtifactAccount(): Promise<boolean> {
  return (await useAppStore.getState().connectCurrentOrcaProfile())?.status === 'connected'
}

function showArtifactPublishedToast(result: ArtifactPublishResult): void {
  toast.success(
    result.change === 'created'
      ? translate('auto.components.artifacts.artifact-publish-flow.430019efd0', 'Artifact shared')
      : translate('auto.components.artifacts.artifact-publish-flow.2fc727c831', 'Artifact updated')
  )
}

function artifactPreparationErrorDescription(code: ArtifactPublishPreparationErrorCode): string {
  switch (code) {
    case 'empty':
      return translate(
        'auto.components.artifacts.artifact-publish-flow.fbb5018602',
        'This file is empty.'
      )
    case 'too-large':
      return translate(
        'auto.components.artifacts.artifact-publish-flow.6112db5a1c',
        'Artifacts shared from Orca must be smaller than 800 KB.'
      )
    case 'unreadable':
      return translate(
        'auto.components.artifacts.artifact-publish-flow.e2ed5acd8c',
        "Orca couldn't read this file. Open it from a workspace and try again."
      )
    case 'unsupported':
      return translate(
        'auto.components.artifacts.artifact-publish-flow.6d475e9b25',
        'Only local HTML and Markdown files can be shared as artifacts.'
      )
    case 'binary':
      return translate(
        'auto.components.artifacts.artifact-publish-flow.29a406be09',
        'Artifacts must contain text.'
      )
  }
}
