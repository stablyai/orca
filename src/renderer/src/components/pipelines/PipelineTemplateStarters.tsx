import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { PipelineSelection } from '../../../../shared/pipelines/pipeline-contracts'
import type { PipelineV2TemplateSaveParams } from '../../../../shared/rpc-contract/pipeline-v2-params'
import { PipelineSelectField } from './PipelineFormFields'

export function PipelineTemplateStarters({
  disabled,
  onCreate,
  onCustom
}: {
  disabled: boolean
  onCreate: (source: Extract<PipelineV2TemplateSaveParams, { source: unknown }>['source']) => void
  onCustom: () => void
}) {
  const t = useTranslate()
  const [legacy, setLegacy] = useState<(PipelineSelection & { title: string })[]>([])
  const [selected, setSelected] = useState('')
  useEffect(() => {
    let cancelled = false
    void callRuntimeRpc<{ profiles: (PipelineSelection & { title: string })[] }>(
      { kind: 'local' },
      'pipeline.profiles'
    )
      .then((result) => {
        if (!cancelled) {
          setLegacy(result.profiles)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(['single', 'implement-checks', 'configurable-review'] as const).map((seedId) => (
          <Button
            key={seedId}
            variant="outline"
            disabled={disabled}
            onClick={() => onCreate({ kind: 'seed', seedId })}
          >
            {seedId === 'single'
              ? t('pipelines.singlePreset', 'Single stage')
              : seedId === 'implement-checks'
                ? t('pipelines.checksPreset', 'Implementation and checks')
                : t('pipelines.reviewPreset', 'Configurable review')}
          </Button>
        ))}
        <Button variant="outline" disabled={disabled} onClick={onCustom}>
          {t('pipelines.customTemplate', 'Custom template')}
        </Button>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => onCreate({ kind: 'seed', seedId: 'coding' })}
        >
          {t('pipelines.developmentSeed', 'Development template')}
        </Button>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => onCreate({ kind: 'seed', seedId: 'research' })}
        >
          {t('pipelines.researchSeed', 'Research template')}
        </Button>
      </div>
      {legacy.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <PipelineSelectField
            label={t('pipelines.cloneV1', 'Copy a legacy pipeline')}
            value={selected}
            options={legacy.map((profile) => ({ value: profile.id, label: profile.title }))}
            onChange={setSelected}
            disabled={disabled}
          />
          <Button
            variant="outline"
            disabled={disabled || !selected}
            onClick={() => {
              const profile = legacy.find((row) => row.id === selected)!
              onCreate({
                kind: 'v1-clone',
                profile: { id: profile.id, version: profile.version, digest: profile.digest }
              })
            }}
          >
            {t('pipelines.copy', 'Copy to draft')}
          </Button>
        </div>
      )}
    </div>
  )
}
