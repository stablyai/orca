import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AutomationCreateTarget } from './AutomationEditorDialog'
import type { AutomationTemplate } from './automation-templates'

type AutomationEditorDialogHeaderProps = {
  isEditing: boolean
  isEditingExternal: boolean
  isHermesCreate: boolean
  isCreateMode: boolean
  createTarget: AutomationCreateTarget
  draftName: string
  templateOpen: boolean
  templates: AutomationTemplate[]
  modeToggleItemClassName: string
  pickerTriggerClassName: string
  onCreateTargetChange: (target: AutomationCreateTarget) => void
  onDraftNameChange: (name: string) => void
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

export function AutomationEditorDialogHeader({
  isEditing,
  isEditingExternal,
  isHermesCreate,
  isCreateMode,
  createTarget,
  draftName,
  templateOpen,
  templates,
  modeToggleItemClassName,
  pickerTriggerClassName,
  onCreateTargetChange,
  onDraftNameChange,
  onTemplateOpenChange,
  onApplyTemplate
}: AutomationEditorDialogHeaderProps): React.JSX.Element {
  return (
    <DialogHeader className="border-b border-border/50 px-5 py-4 pr-12">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <DialogTitle className="text-sm font-medium">
            {isEditing
              ? 'Edit automation'
              : isEditingExternal
                ? 'Edit Hermes automation'
                : isHermesCreate
                  ? 'Create Hermes automation'
                  : 'Create automation'}
          </DialogTitle>
          <Input
            value={draftName}
            placeholder="Weekday repo audit"
            aria-label="Automation name"
            className="h-10 max-w-md border-input bg-input/30 px-3 text-lg font-semibold text-foreground shadow-xs placeholder:text-muted-foreground dark:bg-input/30"
            onChange={(event) => onDraftNameChange(event.target.value)}
          />
        </div>
        {isCreateMode ? (
          <div className="flex shrink-0 items-center gap-2">
            <ToggleGroup
              type="single"
              value={createTarget}
              onValueChange={(value) =>
                value && onCreateTargetChange(value as AutomationCreateTarget)
              }
              variant="outline"
              size="sm"
              className="grid grid-cols-2"
            >
              <ToggleGroupItem value="orca" className={modeToggleItemClassName}>
                Orca
              </ToggleGroupItem>
              <ToggleGroupItem value="hermes" className={modeToggleItemClassName}>
                Hermes
              </ToggleGroupItem>
            </ToggleGroup>
            <Popover open={templateOpen} onOpenChange={onTemplateOpenChange}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={pickerTriggerClassName}
                >
                  <Sparkles className="size-4" />
                  Use template
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
      </div>
    </DialogHeader>
  )
}
