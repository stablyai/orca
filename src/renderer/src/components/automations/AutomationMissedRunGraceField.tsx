import { Info } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'
import { translate } from '@/i18n/i18n'

type AutomationMissedRunGraceFieldProps = {
  draft: AutomationDraft
  disabled: boolean
  pickerTriggerClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationMissedRunGraceField({
  draft,
  disabled,
  pickerTriggerClassName,
  onDraftChange
}: AutomationMissedRunGraceFieldProps): React.JSX.Element {
  return (
    <Field
      label={
        <span className="inline-flex items-center gap-1">
          {translate("auto.components.automations.AutomationMissedRunGraceField.fc089e5fde", "Grace")}<Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={translate("auto.components.automations.AutomationMissedRunGraceField.3df53d554a", "Missed-run grace help")}
                className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-72">
              {translate("auto.components.automations.AutomationMissedRunGraceField.3d70c185c8", "If Orca or the execution host was unavailable at the scheduled time, Orca runs one missed occurrence when it becomes available within this window. Older missed runs are skipped.")}</TooltipContent>
          </Tooltip>
        </span>
      }
    >
      <Select
        value={draft.missedRunGraceMinutes}
        disabled={disabled}
        onValueChange={(missedRunGraceMinutes) =>
          onDraftChange((current) => ({ ...current, missedRunGraceMinutes }))
        }
      >
        <SelectTrigger className={`w-full ${pickerTriggerClassName}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
          <SelectItem value="0">{translate("auto.components.automations.AutomationMissedRunGraceField.529dc6c0b7", "No grace")}</SelectItem>
          <SelectItem value="30">{translate("auto.components.automations.AutomationMissedRunGraceField.e5ad263ae5", "30 minutes")}</SelectItem>
          <SelectItem value="60">{translate("auto.components.automations.AutomationMissedRunGraceField.521f77cd58", "1 hour")}</SelectItem>
          <SelectItem value="180">{translate("auto.components.automations.AutomationMissedRunGraceField.2dc9ee84d0", "3 hours")}</SelectItem>
          <SelectItem value="720">{translate("auto.components.automations.AutomationMissedRunGraceField.ba50e2a230", "12 hours")}</SelectItem>
          <SelectItem value="1440">{translate("auto.components.automations.AutomationMissedRunGraceField.adbab51feb", "24 hours")}</SelectItem>
          <SelectItem value="2880">{translate("auto.components.automations.AutomationMissedRunGraceField.0f4459e91d", "48 hours")}</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  )
}
