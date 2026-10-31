import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { AutomationTemplate } from './automation-templates'
import { translate } from '@/i18n/i18n'

type AutomationEditorDialogHeaderProps = {
  isEditing: boolean
  isCreateMode: boolean
  templateOpen: boolean
  templates: AutomationTemplate[]
  onTemplateOpenChange: (open: boolean) => void
  onApplyTemplate: (template: AutomationTemplate) => void
}

function AutomationTemplateCard({
  template,
  onSelect
}: {
  template: AutomationTemplate
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="rounded-md border border-border/70 bg-background px-3 py-2 text-left shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="text-[11px] font-medium uppercase text-muted-foreground">
        {template.category}
      </div>
      <div className="mt-1 text-sm font-medium">{template.label}</div>
      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{template.description}</div>
    </button>
  )
}

function getEditorTitle(args: { isEditing: boolean }): string {
  if (args.isEditing) {
    return translate(
      'auto.components.automations.AutomationEditorDialogHeader.17086b48ee',
      'Edit automation'
    )
  }
  return translate(
    'auto.components.automations.AutomationEditorDialogHeader.4133d33862',
    'Create automation'
  )
}

export function AutomationEditorDialogHeader({
  isEditing,
  isCreateMode,
  templateOpen,
  templates,
  onTemplateOpenChange,
  onApplyTemplate
}: AutomationEditorDialogHeaderProps): React.JSX.Element {
  const title = getEditorTitle({ isEditing })

  return (
    <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border/50 px-5 py-2.5 pr-12 text-left">
      <DialogTitle className="min-w-0 truncate text-sm font-medium">{title}</DialogTitle>
      {isCreateMode ? (
        <div className="flex shrink-0 items-center gap-2">
          <Popover open={templateOpen} onOpenChange={onTemplateOpenChange}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="sm">
                <Sparkles className="size-4" />
                {translate(
                  'auto.components.automations.AutomationEditorDialogHeader.31f9253920',
                  'Use template'
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96 p-3">
              <div className="grid gap-2">
                {templates.map((template) => (
                  <AutomationTemplateCard
                    key={template.id}
                    template={template}
                    onSelect={() => onApplyTemplate(template)}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
    </DialogHeader>
  )
}
