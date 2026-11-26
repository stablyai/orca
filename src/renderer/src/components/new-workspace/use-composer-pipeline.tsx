import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { ComposerCardProps } from '@/hooks/useComposerState'
import { Button } from '@/components/ui/button'
import { PipelineManagerSheet } from '../pipelines/PipelineManagerSheet'
import { PipelineSelectionPreview } from '../pipelines/PipelineSelectionPreview'
import { callPipelineRpc } from '../pipelines/pipeline-api'
import { PipelinePicker, pipelineChoiceKey, type PipelineChoice } from './PipelinePicker'
import type { ComposerModalData } from './composer/composer-modal-data'

export function useComposerPipeline(
  card: ComposerCardProps,
  recovery?: ComposerModalData['recovery']
) {
  const t = useTranslate()
  const projectId = card.repoId
  const [profiles, setProfiles] = useState<PipelineChoice[]>([])
  const [selection, setSelection] = useState(() => recovery?.pipeline)
  const [runtimeId, setRuntimeId] = useState(recovery?.pipelineRuntimeId ?? '')
  const [managerOpen, setManagerOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const selectedKey = selection
    ? 'engineVersion' in selection && selection.engineVersion === 2
      ? `v2:${selection.digest}`
      : `v1:${selection.id}`
    : ''
  const pipeline = profiles.find((row) => pipelineChoiceKey(row) === selectedKey)
  const pipelineEligible =
    card.selectedRepoIsGit &&
    card.selectedRepoExecutionHostId === 'local' &&
    !card.selectedEphemeralVmRecipeId
  useEffect(() => {
    let cancelled = false
    setProfiles([])
    setError('')
    if (!pipelineEligible) {
      return
    }
    void Promise.all([
      callRuntimeRpc<{ profiles: PipelineChoice[] }>({ kind: 'local' }, 'pipeline.profiles'),
      callPipelineRpc<{ profiles: PipelineChoice[]; cursor: number; hasMore: boolean }>(
        'pipeline.v2.profiles',
        { projectId, limit: 50 }
      )
    ])
      .then(async ([legacy, native]) => {
        const profiles = [...legacy.profiles, ...native.profiles]
        let page = native
        while (page.hasMore && profiles.length < 256) {
          page = await callPipelineRpc('pipeline.v2.profiles', {
            projectId,
            cursor: page.cursor,
            limit: 50,
            expectedRuntimeId: native.runtimeId
          })
          profiles.push(...page.profiles)
        }
        if (page.hasMore) {
          throw new Error(
            'Pipeline library exceeds the selection limit. Disable unused versions in the manager.'
          )
        }
        if (!cancelled) {
          setProfiles(profiles)
          setRuntimeId(native.runtimeId)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setError(String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectId, pipelineEligible, refresh])
  const scopeMatches =
    !selection ||
    !('engineVersion' in selection) ||
    selection.engineVersion !== 2 ||
    selection.projectId === projectId
  const picker =
    pipelineEligible || selection ? (
      <div className="space-y-2">
        <PipelinePicker
          profiles={scopeMatches ? profiles : []}
          selected={selectedKey}
          onSelect={(key) => {
            const chosen = profiles.find((row) => pipelineChoiceKey(row) === key)
            setSelection(
              chosen
                ? chosen.engineVersion === 2
                  ? {
                      engineVersion: 2,
                      projectId: chosen.projectId,
                      id: chosen.id,
                      version: chosen.version,
                      digest: chosen.digest
                    }
                  : { id: chosen.id, version: chosen.version, digest: chosen.digest }
                : undefined
            )
          }}
          disabled={card.creating}
        />
        {selection &&
          'engineVersion' in selection &&
          selection.engineVersion === 2 &&
          scopeMatches && <PipelineSelectionPreview selection={selection} runtimeId={runtimeId} />}
        <Button
          variant="link"
          size="sm"
          disabled={!pipelineEligible || card.creating}
          onClick={() => setManagerOpen(true)}
        >
          {t('pipelines.manage', 'Manage pipeline templates')}
        </Button>
        {(error || (selection && (!pipelineEligible || !scopeMatches || !pipeline))) && (
          <p role="alert" className="text-xs text-destructive">
            {error ||
              t(
                'pipelines.selectionUnavailable',
                'The selected version is unavailable for this project. Choose an enabled version or create without a pipeline.'
              )}
          </p>
        )}
        {pipelineEligible && (
          <PipelineManagerSheet
            key={projectId}
            projectId={projectId}
            workspacePath={card.selectedRepoPath ?? undefined}
            open={managerOpen}
            onOpenChange={setManagerOpen}
            onPublished={() => setRefresh((value) => value + 1)}
          />
        )}
      </div>
    ) : undefined
  return {
    profile: selection,
    picker,
    blocked:
      Boolean(selection) && (!pipeline || !pipelineEligible || !scopeMatches || Boolean(error)),
    selection,
    runtimeId
  }
}
