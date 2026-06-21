import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Field } from './automation-page-parts'
import { AutomationPrecheckFields } from './AutomationPrecheckFields'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationEditorPromptSectionProps = {
  draft: AutomationDraft
  isHermesCreate: boolean
  pickerTriggerClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationEditorPromptSection({
  draft,
  isHermesCreate,
  pickerTriggerClassName,
  onDraftChange
}: AutomationEditorPromptSectionProps): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4 scrollbar-sleek">
      {draft.scheduleWarning ? (
        <div className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {draft.scheduleWarning}
        </div>
      ) : null}
      <Field
        label={translate('auto.components.automations.AutomationEditorDialog.058c23cb3f', 'Prompt')}
      >
        <textarea
          value={draft.prompt}
          placeholder={translate(
            'auto.components.automations.AutomationEditorDialog.6d778190b7',
            'Run the weekly dependency audit and summarize risky changes.'
          )}
          onChange={(event) =>
            onDraftChange((current) => ({ ...current, prompt: event.target.value }))
          }
          className="min-h-[260px] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationEditorDialog.827b25a81e',
            'Supports skills, file paths, and built-in commands like'
          )}{' '}
          <code className="rounded bg-muted px-1 font-mono text-[11px]">
            {translate('auto.components.automations.AutomationEditorDialog.a4ac8fcc62', '/goal')}
          </code>
          .
        </p>
      </Field>
      {/* Why: the Orca/Hermes target toggle changes form height; collapsing the
          Orca-only precheck row keeps the dialog from snapping vertically. */}
      <div
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
          isHermesCreate ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
        )}
        aria-hidden={isHermesCreate}
        inert={isHermesCreate}
      >
        <div className="min-h-0">
          <div
            className={cn(
              'mt-3 grid gap-3 transition-[opacity,transform] duration-150 ease-out sm:grid-cols-[minmax(0,1fr)_9rem]',
              isHermesCreate
                ? '-translate-y-1 opacity-0 delay-0'
                : 'translate-y-0 opacity-100 delay-200'
            )}
          >
            <AutomationPrecheckFields
              draft={draft}
              disabled={isHermesCreate}
              pickerTriggerClassName={pickerTriggerClassName}
              onDraftChange={onDraftChange}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
