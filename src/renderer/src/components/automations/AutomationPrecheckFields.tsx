import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'

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
      <Field label="Precheck">
        <textarea
          value={draft.precheckCommand}
          disabled={disabled}
          placeholder="gh pr list --json number -q '.[0].number'"
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              precheckCommand: event.target.value
            }))
          }
          className="min-h-[68px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        />
      </Field>
      <Field label="Timeout">
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
            <SelectItem value="30">30 sec</SelectItem>
            <SelectItem value="60">1 min</SelectItem>
            <SelectItem value="120">2 min</SelectItem>
            <SelectItem value="300">5 min</SelectItem>
            <SelectItem value="600">10 min</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </>
  )
}
