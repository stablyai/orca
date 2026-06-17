import { BookmarkPlus, Pencil, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { UserAutomationTemplate } from '../../../../shared/automations-types'
import type { AutomationCreateTarget } from './AutomationEditorDialog'
import type { AutomationTemplate } from './automation-templates'
import { translate } from '@/i18n/i18n'

type AutomationEditorDialogHeaderProps = {
  isEditing: boolean
  isEditingExternal: boolean
  isHermesCreate: boolean
  isCreateMode: boolean
  createTarget: AutomationCreateTarget
  draftName: string
  templateOpen: boolean
  templates: AutomationTemplate[]
  userTemplates: UserAutomationTemplate[]
  isEditingTemplate: boolean
  modeToggleItemClassName: string
  pickerTriggerClassName: string
  onCreateTargetChange: (target: AutomationCreateTarget) => void
  onDraftNameChange: (name: string) => void
  onTemplateOpenChange: (open: boolean) => void
  onApplyTemplate: (template: AutomationTemplate) => void
  onApplyUserTemplate: (template: UserAutomationTemplate) => void
  onEditUserTemplate: (template: UserAutomationTemplate) => void
  onDeleteUserTemplate: (id: string) => void
  onSaveAsTemplate: () => void
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

function UserTemplateCard({
  template,
  onApply,
  onEdit,
  onDelete
}: {
  template: UserAutomationTemplate
  onApply: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-stretch gap-1 rounded-md border border-border/70 bg-background shadow-xs transition-colors focus-within:ring-[3px] focus-within:ring-ring/50 hover:bg-accent/60">
      <button
        type="button"
        onClick={onApply}
        className="min-w-0 flex-1 px-3 py-2 text-left focus-visible:outline-none"
      >
        <div className="truncate text-sm font-medium">{template.label}</div>
        {template.description ? (
          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {template.description}
          </div>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label={translate(
            'auto.components.automations.AutomationEditorDialogHeader.editTemplate',
            'Edit template'
          )}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          aria-label={translate(
            'auto.components.automations.AutomationEditorDialogHeader.deleteTemplate',
            'Delete template'
          )}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
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
  userTemplates,
  isEditingTemplate,
  modeToggleItemClassName,
  pickerTriggerClassName,
  onCreateTargetChange,
  onDraftNameChange,
  onTemplateOpenChange,
  onApplyTemplate,
  onApplyUserTemplate,
  onEditUserTemplate,
  onDeleteUserTemplate,
  onSaveAsTemplate
}: AutomationEditorDialogHeaderProps): React.JSX.Element {
  // Why: templates capture only orca soft fields, so the save/use actions are
  // hidden for Hermes and external-automation editing.
  const showTemplateActions = createTarget === 'orca' && !isEditingExternal && !isHermesCreate
  return (
    <DialogHeader className="border-b border-border/50 px-5 py-4 pr-12">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <DialogTitle className="text-sm font-medium">
            {isEditing
              ? translate(
                  'auto.components.automations.AutomationEditorDialogHeader.17086b48ee',
                  'Edit automation'
                )
              : isEditingExternal
                ? translate(
                    'auto.components.automations.AutomationEditorDialogHeader.03142e7721',
                    'Edit Hermes automation'
                  )
                : isHermesCreate
                  ? translate(
                      'auto.components.automations.AutomationEditorDialogHeader.0a75e5e2fa',
                      'Create Hermes automation'
                    )
                  : translate(
                      'auto.components.automations.AutomationEditorDialogHeader.4133d33862',
                      'Create automation'
                    )}
          </DialogTitle>
          <Input
            value={draftName}
            placeholder={translate(
              'auto.components.automations.AutomationEditorDialogHeader.1d9826933e',
              'Weekday repo audit'
            )}
            aria-label={translate(
              'auto.components.automations.AutomationEditorDialogHeader.58f56b73d9',
              'Automation name'
            )}
            className="h-10 max-w-md border-input bg-input/30 px-3 text-lg font-semibold text-foreground shadow-xs placeholder:text-muted-foreground dark:bg-input/30"
            onChange={(event) => onDraftNameChange(event.target.value)}
          />
        </div>
        {isCreateMode || showTemplateActions ? (
          <div className="flex shrink-0 items-center gap-2">
            {isCreateMode ? (
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
                  {translate(
                    'auto.components.automations.AutomationEditorDialogHeader.6f309eef8d',
                    'Orca'
                  )}
                </ToggleGroupItem>
                <ToggleGroupItem value="hermes" className={modeToggleItemClassName}>
                  {translate(
                    'auto.components.automations.AutomationEditorDialogHeader.7e35393632',
                    'Hermes'
                  )}
                </ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            {showTemplateActions ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={pickerTriggerClassName}
                onClick={onSaveAsTemplate}
              >
                <BookmarkPlus className="size-4" />
                {isEditingTemplate
                  ? translate(
                      'auto.components.automations.AutomationEditorDialogHeader.updateTemplate',
                      'Update template'
                    )
                  : translate(
                      'auto.components.automations.AutomationEditorDialogHeader.saveAsTemplate',
                      'Save as template'
                    )}
              </Button>
            ) : null}
            {isCreateMode && showTemplateActions ? (
              <Popover open={templateOpen} onOpenChange={onTemplateOpenChange}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={pickerTriggerClassName}
                  >
                    <Sparkles className="size-4" />
                    {translate(
                      'auto.components.automations.AutomationEditorDialogHeader.31f9253920',
                      'Use template'
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-96 space-y-3 p-3">
                  {userTemplates.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-[11px] font-medium uppercase text-muted-foreground">
                        {translate(
                          'auto.components.automations.AutomationEditorDialogHeader.yourTemplates',
                          'Your templates'
                        )}
                      </div>
                      {userTemplates.map((template) => (
                        <UserTemplateCard
                          key={template.id}
                          template={template}
                          onApply={() => onApplyUserTemplate(template)}
                          onEdit={() => onEditUserTemplate(template)}
                          onDelete={() => onDeleteUserTemplate(template.id)}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {userTemplates.length > 0 ? (
                      <div className="text-[11px] font-medium uppercase text-muted-foreground">
                        {translate(
                          'auto.components.automations.AutomationEditorDialogHeader.builtInTemplates',
                          'Built-in'
                        )}
                      </div>
                    ) : null}
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
            ) : null}
          </div>
        ) : null}
      </div>
    </DialogHeader>
  )
}
