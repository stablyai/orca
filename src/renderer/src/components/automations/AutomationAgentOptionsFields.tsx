import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'

const DEFAULT_VALUE = '__orca_default__'

type AutomationAgentOptionsFieldsProps = {
  draft: AutomationDraft
  pickerTriggerClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationAgentOptionsFields({
  draft,
  pickerTriggerClassName,
  onDraftChange
}: AutomationAgentOptionsFieldsProps): React.JSX.Element | null {
  const catalog = getAgentSessionOptionCatalog(draft.agentId)
  if (!catalog?.supportsWorkerLaunchPreferences) {
    return null
  }
  const selectedModel = findCatalogModel(catalog, draft.model)
  const models =
    draft.model && !selectedModel
      ? [
          { id: draft.model, label: draft.model, options: catalog.unknownModelOptions ?? [] },
          ...catalog.models
        ]
      : catalog.models
  const effortOption = (selectedModel?.options ?? catalog.unknownModelOptions ?? []).find(
    (option) => option.id === 'effort' && option.kind.type === 'select'
  )
  const catalogEffortChoices = effortOption?.kind.type === 'select' ? effortOption.kind.choices : []
  const effortChoices =
    draft.effort && !catalogEffortChoices.some((choice) => choice.value === draft.effort)
      ? [{ value: draft.effort, label: draft.effort }, ...catalogEffortChoices]
      : catalogEffortChoices

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field
        labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
        label={translate('auto.components.automations.AutomationAgentOptionsFields.model', 'Model')}
      >
        <Select
          value={draft.model || DEFAULT_VALUE}
          onValueChange={(model) =>
            onDraftChange((current) => ({
              ...current,
              model: model === DEFAULT_VALUE ? '' : model,
              effort: ''
            }))
          }
        >
          <SelectTrigger className={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
            <SelectItem value={DEFAULT_VALUE}>
              {translate(
                'auto.components.automations.AutomationAgentOptionsFields.agentDefault',
                'Agent default'
              )}
            </SelectItem>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {draft.model && effortChoices.length > 0 ? (
        <Field
          labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
          label={translate(
            'auto.components.automations.AutomationAgentOptionsFields.effort',
            'Effort'
          )}
        >
          <Select
            value={draft.effort || DEFAULT_VALUE}
            onValueChange={(effort) =>
              onDraftChange((current) => ({
                ...current,
                effort: effort === DEFAULT_VALUE ? '' : effort
              }))
            }
          >
            <SelectTrigger className={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
              <SelectItem value={DEFAULT_VALUE}>
                {translate(
                  'auto.components.automations.AutomationAgentOptionsFields.modelDefault',
                  'Model default'
                )}
              </SelectItem>
              {effortChoices.map((choice) => (
                <SelectItem key={choice.value} value={String(choice.value)}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <div />
      )}
    </div>
  )
}
