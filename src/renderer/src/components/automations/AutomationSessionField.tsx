import React from 'react'
import { Info } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'
import { translate } from '@/i18n/i18n'

type AutomationSessionFieldProps = {
  draft: AutomationDraft
  toggleItemClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationSessionField({
  draft,
  toggleItemClassName,
  onDraftChange
}: AutomationSessionFieldProps): React.JSX.Element {
  return (
    <Field
      label={
        <span className="inline-flex items-center gap-1">
          {translate('auto.components.automations.AutomationSessionField.5ad314118e', 'Session')}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={translate(
                  'auto.components.automations.AutomationSessionField.4bdce31f37',
                  'Session reuse help'
                )}
                className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6} className="max-w-72">
              {translate(
                'auto.components.automations.AutomationSessionField.b675112193',
                'Reuse sends future runs to the previous live automation session. If that session is gone, Orca starts a fresh one.'
              )}
            </TooltipContent>
          </Tooltip>
        </span>
      }
    >
      <ToggleGroup
        type="single"
        value={draft.workspaceMode === 'existing' && draft.reuseSession ? 'reuse' : 'fresh'}
        onValueChange={(value) => {
          if (!value) {
            return
          }
          onDraftChange((current) => ({
            ...current,
            reuseSession: value === 'reuse',
            workspaceMode: value === 'reuse' ? 'existing' : current.workspaceMode
          }))
        }}
        variant="outline"
        size="sm"
        className="grid w-full grid-cols-2"
      >
        <ToggleGroupItem value="fresh" className={toggleItemClassName}>
          {translate('auto.components.automations.AutomationSessionField.c90888ee94', 'Fresh')}
        </ToggleGroupItem>
        <ToggleGroupItem value="reuse" className={toggleItemClassName}>
          {translate('auto.components.automations.AutomationSessionField.f3c76dce51', 'Reuse')}
        </ToggleGroupItem>
      </ToggleGroup>
    </Field>
  )
}
