import { KeyRound, Play } from 'lucide-react'
import type React from 'react'
import type { OrcaHooks } from '../../../../../../shared/orca-yaml-hook-types'
import { isRecipeEnvNamePassed } from '../../../../../../shared/ephemeral-vm-recipe-env'
import { Button } from '../../../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { isWindowsUserAgent } from '@/app-shell/platform/user-agent-platform'

type RecipeCatalogEntry = Awaited<
  ReturnType<typeof window.api.ephemeralVm.listRecipeCatalog>
>[number]
type Recipe = NonNullable<OrcaHooks['environmentRecipes']>[number]

const MAX_LISTED_ENV_NAMES = 6

export function EphemeralVmRecipeRow({
  entry,
  recipe,
  credentialEnvNames,
  onUse
}: {
  entry: RecipeCatalogEntry
  recipe: Recipe
  /** Credential-like names in Orca's environment; null until loaded or when unavailable. */
  credentialEnvNames: readonly string[] | null
  onUse: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const destroyLabel = recipe.destroyDisabled
    ? t('auto.components.NewWorkspaceComposerCard.destroyDisabled', 'destroy disabled')
    : recipe.destroy
      ? t('auto.components.NewWorkspaceComposerCard.destroyConfigured', 'destroy configured')
      : t('auto.components.NewWorkspaceComposerCard.noDestroyConfigured', 'no destroy')
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
        <RecipeEnvExposure recipe={recipe} credentialEnvNames={credentialEnvNames} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="outline" size="xs" className="gap-1.5" onClick={onUse}>
          <Play className="size-3" />
          {t('auto.components.settings.EphemeralVmRecipeRow.useInWorkspace', 'Use in workspace')}
        </Button>
      </div>
    </div>
  )
}

function RecipeEnvExposure({
  recipe,
  credentialEnvNames
}: {
  recipe: Recipe
  credentialEnvNames: readonly string[] | null
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!credentialEnvNames) {
    return null
  }
  const platform = isWindowsUserAgent() ? 'win32' : 'linux'
  const passed = credentialEnvNames.filter((name) =>
    isRecipeEnvNamePassed(name, recipe.passEnv, platform)
  )
  if (passed.length === 0) {
    return recipe.passEnv ? (
      <p className="mt-1 text-xs text-muted-foreground">
        {t(
          'auto.components.settings.EphemeralVmRecipeRow.envLimited',
          'Scripts only receive the variables listed in passEnv, plus PATH, HOME and similar basics.'
        )}
      </p>
    ) : null
  }
  const listed = passed.slice(0, MAX_LISTED_ENV_NAMES).join(', ')
  const names =
    passed.length > MAX_LISTED_ENV_NAMES
      ? t(
          'auto.components.settings.EphemeralVmRecipeRow.envNamesMore',
          '{{names}} +{{count}} more',
          {
            names: listed,
            count: passed.length - MAX_LISTED_ENV_NAMES
          }
        )
      : listed
  return (
    <p
      className="mt-1 flex items-start gap-1.5 text-xs text-status-warning-text"
      title={passed.join('\n')}
      data-testid="recipe-env-exposure"
    >
      <KeyRound className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">
        {recipe.passEnv
          ? t(
              'auto.components.settings.EphemeralVmRecipeRow.envExposedAllowlist',
              'Scripts run on this computer and receive these credentials from passEnv: {{names}}.',
              { names }
            )
          : t(
              'auto.components.settings.EphemeralVmRecipeRow.envExposedAll',
              'Scripts run on this computer with your full environment, including {{names}}. Set passEnv on the recipe to pass only what it needs.',
              { names }
            )}
      </span>
    </p>
  )
}
