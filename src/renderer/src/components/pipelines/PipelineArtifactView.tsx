import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { callPipelineRpc } from './pipeline-api'
import type { PipelineRunScope } from './pipeline-run-read'
import type { PipelineV2OwnerDecisionRecord } from '../../../../shared/pipelines/v2/pipeline-v2-owner-history'
import type { PipelineV2Candidate } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { PipelineEvidenceSummary } from './PipelineEvidenceSummary'

type Artifact =
  | (PipelineV2OwnerDecisionRecord & { kind: 'owner_decision' })
  | {
      id: string
      kind?: never
      summary: string
      result: Omit<PipelineV2Candidate['result'], 'summary'>
    }
async function readPipelineArtifact(scope: PipelineRunScope, artifactId: string) {
  const result = await callPipelineRpc<{ artifacts: Artifact[] }>('pipeline.v2.context', {
    id: scope.runId,
    projectId: scope.projectId,
    expectedInstanceId: scope.workspaceInstanceId,
    artifactId
  })
  if (result.artifacts[0]?.id !== artifactId) {
    throw new Error('pipeline_artifact_not_found')
  }
  return result.artifacts[0]
}
export function PipelineArtifactView({
  scope,
  artifactId,
  label
}: {
  scope: PipelineRunScope
  artifactId: string
  label: string
}) {
  const t = useTranslate()
  const [artifact, setArtifact] = useState<Artifact>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => {
    setBusy(true)
    setError('')
    return readPipelineArtifact(scope, artifactId)
      .then(setArtifact)
      .catch((error) => setError(String(error)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="space-y-2">
      <Button
        variant="link"
        size="sm"
        disabled={busy}
        onClick={() => {
          if (artifact?.id === artifactId) {
            setArtifact(undefined)
          } else {
            void load()
          }
        }}
      >
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {artifact?.id === artifactId && (
        <div className="space-y-3 rounded-md border p-3">
          {artifact.kind === 'owner_decision' ? (
            <>
              <p className="text-sm">
                {artifact.action === 'accept'
                  ? t('pipelines.ownerAccepted', 'Owner accepted the result')
                  : t('pipelines.ownerRequestedChanges', 'Owner requested changes')}
              </p>
              {artifact.comment && (
                <p className="whitespace-pre-wrap break-words text-sm">{artifact.comment}</p>
              )}
            </>
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-sm">{artifact.summary}</p>
              <PipelineEvidenceSummary evidence={artifact.result.evidence} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
