import { useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { PipelineTextField, PipelineSelectField } from './PipelineFormFields'
import { PipelineStageEditor } from './PipelineStageEditor'
import { PipelineCompletionEditor } from './PipelineCompletionEditor'
import {
  newPipelineStage,
  type PipelineEditorDraft,
  type PipelineEditorAction
} from './pipeline-editor-draft'

export function PipelineTemplateEditor({
  editor,
  workspacePath,
  checks,
  onEdit,
  disabled = false
}: {
  editor: PipelineEditorDraft
  workspacePath?: string
  checks?: string[]
  onEdit: (action: PipelineEditorAction) => void
  disabled?: boolean
}) {
  const t = useTranslate()
  const [stageId, setStageId] = useState(editor.template.entryStageId)
  const template = editor.template
  const stage = template.stages.find((stage) => stage.id === stageId) ?? template.stages[0]
  const reorder = (index: number, offset: number) => {
    const ids = template.stages.map((stage) => stage.id)
    const target = index + offset
    if (target < 0 || target >= ids.length) {
      return
    }
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    onEdit({ type: 'reorder', stageIds: ids })
  }
  return (
    <fieldset disabled={disabled} className="@container min-w-0 space-y-5">
      <div className="grid gap-3 @lg:grid-cols-2">
        <PipelineTextField
          label={t('pipelines.templateName', 'Template name')}
          value={template.title}
          maxLength={120}
          onChange={(title) => onEdit({ type: 'template', patch: { title } })}
        />
        <p className="self-end text-xs text-muted-foreground">
          {t('pipelines.versionAutomatic', 'Version numbers are assigned when you publish.')}
        </p>
      </div>
      <PipelineTextField
        label={t('pipelines.description', 'Description')}
        value={template.description}
        maxLength={500}
        multiline
        onChange={(description) => onEdit({ type: 'template', patch: { description } })}
      />
      <PipelineSelectField
        label={t('pipelines.entry', 'Start at')}
        value={template.entryStageId}
        options={template.stages.map((stage) => ({ value: stage.id, label: stage.title }))}
        onChange={(entryStageId) => onEdit({ type: 'template', patch: { entryStageId } })}
      />
      <div className="grid min-w-0 gap-5 @3xl:grid-cols-3">
        <div className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium">{t('pipelines.stages', 'Stages')}</h3>
          <ol className="space-y-1">
            {template.stages.map((value, index) => (
              <li
                key={value.id}
                className="flex min-w-0 items-center gap-1 rounded-md border p-1 data-[current=true]:bg-accent"
                data-current={stage?.id === value.id}
                draggable={!disabled}
                onDragStart={(event) =>
                  event.dataTransfer.setData('application/orca-pipeline-stage', value.id)
                }
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const source = event.dataTransfer.getData('application/orca-pipeline-stage')
                  const ids = template.stages.map((stage) => stage.id)
                  if (!ids.includes(source) || source === value.id) {
                    return
                  }
                  ids.splice(ids.indexOf(source), 1)
                  ids.splice(index, 0, source)
                  onEdit({ type: 'reorder', stageIds: ids })
                }}
              >
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  aria-pressed={stage?.id === value.id}
                  onClick={() => setStageId(value.id)}
                >
                  <span className="truncate">
                    {index + 1}. {value.title}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('pipelines.moveUp', 'Move {{stage}} up', { stage: value.title })}
                  disabled={disabled || index === 0}
                  onClick={() => reorder(index, -1)}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('pipelines.moveDown', 'Move {{stage}} down', {
                    stage: value.title
                  })}
                  disabled={disabled || index === template.stages.length - 1}
                  onClick={() => reorder(index, 1)}
                >
                  <ArrowDown className="size-4" />
                </Button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            {(['agent', 'checks'] as const).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                size="sm"
                disabled={template.stages.length >= 32}
                onClick={() => {
                  const stage = newPipelineStage(kind)
                  onEdit({ type: 'insert', stage })
                  setStageId(stage.id)
                }}
              >
                {kind === 'agent'
                  ? t('pipelines.addAgent', 'Add agent stage')
                  : t('pipelines.addChecks', 'Add checks stage')}
              </Button>
            ))}
          </div>
        </div>
        {stage && (
          <div className="min-w-0 space-y-3 @3xl:col-span-2">
            <PipelineStageEditor
              key={stage.id}
              stage={stage}
              stages={template.stages}
              workspacePath={workspacePath}
              checks={checks}
              onChange={(stage) => onEdit({ type: 'stage', stage })}
            />
            <Button
              variant="ghost"
              disabled={template.stages.length === 1}
              onClick={() => onEdit({ type: 'delete', stageId: stage.id })}
            >
              {t('pipelines.removeStage', 'Remove stage')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t(
                'pipelines.removeStageMeaning',
                'References to a removed stage stay visible as validation errors until you choose new targets.'
              )}
            </p>
          </div>
        )}
      </div>
      <PipelineCompletionEditor
        template={template}
        onChange={(patch) => onEdit({ type: 'template', patch })}
      />
    </fieldset>
  )
}
