import React from 'react'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationEditorPromptEditor } from './AutomationEditorPromptEditor'

type AutomationEditorPromptSectionProps = {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  onDismiss: () => void
}

export function AutomationEditorPromptSection({
  draft,
  onDraftChange,
  onDismiss
}: AutomationEditorPromptSectionProps): React.JSX.Element {
  const titleRef = React.useRef<HTMLTextAreaElement>(null)
  const namePlaceholder = translate(
    'auto.components.automations.AutomationEditorDialogHeader.1d9826933e',
    'Weekday repo audit'
  )
  const nameLabel = translate(
    'auto.components.automations.AutomationEditorDialogHeader.58f56b73d9',
    'Automation name'
  )
  const editNameLabel = translate(
    'auto.components.automations.AutomationEditorPromptSection.a7c3e91b04',
    'Edit name'
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-8 py-6">
      {draft.scheduleWarning ? (
        <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {draft.scheduleWarning}
        </div>
      ) : null}
      <div className="group/title mb-5 flex max-w-full items-start gap-1">
        <textarea
          ref={titleRef}
          value={draft.name}
          rows={1}
          placeholder={namePlaceholder}
          aria-label={nameLabel}
          onChange={(event) =>
            onDraftChange((current) => ({ ...current, name: event.target.value }))
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
            }
          }}
          className="max-w-[calc(100%-2rem)] min-w-0 resize-none overflow-hidden border-0 bg-transparent px-0 py-0 text-[28px] font-semibold leading-tight text-foreground shadow-none outline-none ring-0 [field-sizing:content] placeholder:text-muted-foreground/50"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={editNameLabel}
              onClick={() => titleRef.current?.focus()}
              className="mt-1 shrink-0 text-muted-foreground can-hover:opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100 focus-visible:opacity-100"
            >
              <Pencil className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {editNameLabel}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('auto.components.automations.AutomationEditorDialog.058c23cb3f', 'Prompt')}
      </div>
      <AutomationEditorPromptEditor
        value={draft.prompt}
        placeholder={translate(
          'auto.components.automations.AutomationEditorDialog.6d778190b7',
          'Run the weekly dependency audit and summarize risky changes.'
        )}
        ariaLabel={translate(
          'auto.components.automations.AutomationEditorDialog.058c23cb3f',
          'Prompt'
        )}
        onChange={(prompt) => onDraftChange((current) => ({ ...current, prompt }))}
        onDismiss={onDismiss}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.automations.AutomationEditorDialog.827b25a81e',
          'Supports skills, file paths, and built-in commands like'
        )}{' '}
        <code className="rounded bg-muted px-1 font-mono text-[11px]">
          {translate('auto.components.automations.AutomationEditorDialog.a4ac8fcc62', '/goal')}
        </code>
        .
      </p>
    </div>
  )
}
