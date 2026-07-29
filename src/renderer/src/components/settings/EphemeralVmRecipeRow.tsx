import { Play } from 'lucide-react'
import type React from 'react'
import type { OrcaHooks } from '../../../../shared/types'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

type RecipeCatalogEntry = Awaited<
  ReturnType<typeof window.api.ephemeralVm.listRecipeCatalog>
>[number]
type Recipe = NonNullable<OrcaHooks['environmentRecipes']>[number]

export function EphemeralVmRecipeRow({
  entry,
  recipe,
  onUse
}: {
  entry: RecipeCatalogEntry
  recipe: Recipe
  onUse: () => void
}): React.JSX.Element {
  const destroyLabel = recipe.destroyDisabled
    ? translate('auto.components.NewWorkspaceComposerCard.destroyDisabled', 'destroy disabled')
    : recipe.destroy
      ? translate(
          'auto.components.NewWorkspaceComposerCard.destroyConfigured',
          'destroy configured'
        )
      : translate('auto.components.NewWorkspaceComposerCard.noDestroyConfigured', 'no destroy')
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">{recipe.name}</div>
          <span className="shrink-0 text-[11px] text-muted-foreground">{entry.repoName}</span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {recipe.id} · {recipe.create} · {destroyLabel}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="outline" size="xs" className="gap-1.5" onClick={onUse}>
          <Play className="size-3" />
          {translate(
            'auto.components.settings.EphemeralVmRecipeRow.useInWorkspace',
            'Use in workspace'
          )}
        </Button>
      </div>
    </div>
  )
}
