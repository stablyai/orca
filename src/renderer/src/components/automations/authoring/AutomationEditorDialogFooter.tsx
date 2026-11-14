import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

type AutomationEditorDialogFooterProps = {
  isEditing: boolean
  isSaving: boolean
  canSave: boolean
  hasProjects: boolean
  onOpenChange: (open: boolean) => void
  onSave: () => void
}

export function AutomationEditorDialogFooter({
  isEditing,
  isSaving,
  canSave,
  hasProjects,
  onOpenChange,
  onSave
}: AutomationEditorDialogFooterProps): React.JSX.Element {
  const t = useTranslate()
  const saveLabel = isEditing
    ? t('auto.components.automations.AutomationEditorDialog.777548c2d6', 'Save Changes')
    : isSaving
      ? t('auto.components.automations.AutomationEditorDialog.a9d9dccf77', 'Save')
      : t('auto.components.automations.AutomationEditorDialog.e46c1aa9ad', 'Create')

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/50 px-5 py-3">
      <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 shrink-0" />
        <span className="truncate">
          {t(
            'auto.components.automations.AutomationEditorDialog.e8c2a14f70',
            'Once saved, runs automatically until paused.'
          )}
        </span>
      </p>
      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {t('auto.components.automations.AutomationEditorDialog.fb1896a5e7', 'Cancel')}
        </Button>
        <Button onClick={onSave} disabled={isSaving || (!isEditing && !hasProjects) || !canSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}
