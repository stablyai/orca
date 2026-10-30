import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

type RepositorySourceControlAiActionSaveControlsProps = {
  actionDirty: boolean
  isSavingAction: boolean
  onDiscard: () => void
  onSave: () => void
}

export function RepositorySourceControlAiActionSaveControls({
  actionDirty,
  isSavingAction,
  onDiscard,
  onSave
}: RepositorySourceControlAiActionSaveControlsProps) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <p className="text-[11px] text-muted-foreground">
        {actionDirty
          ? translate(
              'auto.components.settings.SourceControlAiActionRecipeDefaults.817128d94e',
              'Unsaved changes'
            )
          : translate(
              'auto.components.settings.SourceControlAiActionRecipeDefaults.9d3cc627f8',
              'Saved'
            )}
      </p>
      <div className="flex items-center gap-2">
        {actionDirty ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onDiscard}
            disabled={isSavingAction}
          >
            {translate(
              'auto.components.settings.SourceControlAiActionRecipeDefaults.b3914ecbbc',
              'Discard'
            )}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={onSave}
          disabled={!actionDirty || isSavingAction}
        >
          {isSavingAction
            ? translate(
                'auto.components.settings.SourceControlAiActionRecipeDefaults.4f549a5fa8',
                'Saving...'
              )
            : translate(
                'auto.components.settings.SourceControlAiActionRecipeDefaults.d18d665e12',
                'Save'
              )}
        </Button>
      </div>
    </div>
  )
}
