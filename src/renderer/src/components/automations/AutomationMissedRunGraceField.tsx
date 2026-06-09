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
          Grace
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Missed-run grace help"
                className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-72">
              If Orca or the execution host was unavailable at the scheduled time, Orca runs one
              missed occurrence when it becomes available within this window. Older missed runs are
              skipped.
            </TooltipContent>
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
          <SelectItem value="0">No grace</SelectItem>
          <SelectItem value="30">30 minutes</SelectItem>
          <SelectItem value="60">1 hour</SelectItem>
          <SelectItem value="180">3 hours</SelectItem>
          <SelectItem value="720">12 hours</SelectItem>
          <SelectItem value="1440">24 hours</SelectItem>
          <SelectItem value="2880">48 hours</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  )
}
