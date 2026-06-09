import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'
import { translate } from '@/i18n/i18n'

type AutomationPrecheckFieldsProps = {
  draft: AutomationDraft
  disabled: boolean
  pickerTriggerClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationPrecheckFields({
  draft,
  disabled,
  pickerTriggerClassName,
  onDraftChange
}: AutomationPrecheckFieldsProps): React.JSX.Element {
  return (
    <>
      <Field label={translate("auto.components.automations.AutomationPrecheckFields.c2a762a180", "Precheck")}>
        <textarea
          value={draft.precheckCommand}
          disabled={disabled}
          placeholder={translate("auto.components.automations.AutomationPrecheckFields.99a577306c", "gh pr list --json number -q '.[0].number'")}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              precheckCommand: event.target.value
            }))
          }
          className="min-h-[68px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        />
      </Field>
      <Field label={translate("auto.components.automations.AutomationPrecheckFields.bb2dfb3629", "Timeout")}>
        <Select
          value={draft.precheckTimeoutSeconds}
          disabled={disabled}
          onValueChange={(precheckTimeoutSeconds) =>
            onDraftChange((current) => ({ ...current, precheckTimeoutSeconds }))
          }
        >
          <SelectTrigger className={`w-full ${pickerTriggerClassName}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
            <SelectItem value="30">{translate("auto.components.automations.AutomationPrecheckFields.51e28cdad9", "30 sec")}</SelectItem>
            <SelectItem value="60">{translate("auto.components.automations.AutomationPrecheckFields.c820119736", "1 min")}</SelectItem>
            <SelectItem value="120">{translate("auto.components.automations.AutomationPrecheckFields.d84d3765fd", "2 min")}</SelectItem>
            <SelectItem value="300">{translate("auto.components.automations.AutomationPrecheckFields.bf49585b3c", "5 min")}</SelectItem>
            <SelectItem value="600">{translate("auto.components.automations.AutomationPrecheckFields.d2a2ac89ac", "10 min")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </>
  )
}
