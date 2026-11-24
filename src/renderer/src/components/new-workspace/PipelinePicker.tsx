import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type {
  PipelineProfile,
  PipelineSelection
} from '../../../../shared/pipelines/pipeline-contracts'
import type { PipelineV2TemplateSelection } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'

export type PipelineChoice =
  | (PipelineSelection & { title: string; profile: PipelineProfile; engineVersion?: 1 })
  | (PipelineV2TemplateSelection & { title: string; stageCount: number })
export const pipelineChoiceKey = (choice: PipelineChoice) =>
  choice.engineVersion === 2 ? `v2:${choice.digest}` : `v1:${choice.id}`

export function PipelinePicker({
  profiles,
  selected,
  onSelect,
  disabled
}: {
  profiles: PipelineChoice[]
  selected: string
  onSelect: (id: string) => void
  disabled?: boolean
}) {
  const id = useId()
  const t = useTranslate()
  const chosen = profiles.find((profile) => pipelineChoiceKey(profile) === selected)
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('taskPipelines.label', 'Task pipeline')}</Label>
      <Select
        value={selected || 'none'}
        onValueChange={(value) => onSelect(value === 'none' ? '' : value)}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={t('taskPipelines.none', 'None')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('taskPipelines.none', 'None')}</SelectItem>
          {profiles.map((profile) => (
            <SelectItem key={pipelineChoiceKey(profile)} value={pipelineChoiceKey(profile)}>
              {profile.title} · {profile.version}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen && chosen.engineVersion !== 2 && (
        <p className="text-xs text-muted-foreground">
          {t(
            'taskPipelines.description',
            'Plan → implement → checks → docs → independent review. Up to {{cycles}} fix cycles. Primary: {{primary}}; reviewer: {{reviewer}}.',
            {
              cycles: chosen.profile.maxFixCycles,
              primary: chosen.profile.roles.primary.agent,
              reviewer: chosen.profile.roles.reviewer.agent
            }
          )}
        </p>
      )}
      {chosen?.engineVersion === 2 && (
        <p className="text-xs text-muted-foreground">
          {t('pipelines.stageCount', '{{count}} stages · version {{version}}', {
            count: chosen.stageCount,
            version: chosen.version
          })}
        </p>
      )}
    </div>
  )
}
