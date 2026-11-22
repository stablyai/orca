import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { PluginReviewSection } from './plugin-review-dialog-layout'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type VmRecipePreview = NonNullable<PluginHostListEntry['vmRecipes']>[number]

function lifecycleLabel(
  phase: VmRecipePreview['commands'][number]['phase'],
  t: Translate = translate
): string {
  switch (phase) {
    case 'create':
      return t('auto.components.settings.PluginVmRecipeConsentPreview.create', 'Create')
    case 'suspend':
      return t('auto.components.settings.PluginVmRecipeConsentPreview.suspend', 'Suspend')
    case 'resume':
      return t('auto.components.settings.PluginVmRecipeConsentPreview.resume', 'Resume')
    case 'destroy':
      return t('auto.components.settings.PluginVmRecipeConsentPreview.destroy', 'Destroy')
  }
}

export function PluginVmRecipeConsentPreview({
  recipes
}: {
  recipes: readonly VmRecipePreview[]
}): React.JSX.Element | null {
  const t = useTranslate()
  if (recipes.length === 0) {
    return null
  }
  return (
    <PluginReviewSection
      headingId="plugin-vm-recipe-consent-heading"
      title={t(
        'auto.components.settings.PluginVmRecipeConsentPreview.heading',
        'VM recipe commands'
      )}
    >
      {recipes.map((recipe) => (
        <div key={recipe.id} className="space-y-2 pt-1">
          <div>
            <p className="text-sm font-medium">{recipe.name}</p>
            {recipe.description ? (
              <p className="text-xs leading-5 text-muted-foreground">{recipe.description}</p>
            ) : null}
          </div>
          <dl className="space-y-2">
            {recipe.commands.map(({ phase, command }) => {
              const phaseLabel = lifecycleLabel(phase, t)
              return (
                <div key={phase}>
                  <dt className="mb-1 text-xs text-muted-foreground">{phaseLabel}</dt>
                  <dd>
                    <pre
                      tabIndex={0}
                      aria-label={t(
                        'auto.components.settings.PluginVmRecipeConsentPreview.commandLabel',
                        '{{value0}} · {{value1}} command',
                        { value0: recipe.name, value1: phaseLabel }
                      )}
                      className="max-h-40 overflow-auto scrollbar-sleek whitespace-pre-wrap break-all rounded-md bg-muted px-2.5 py-2 font-mono text-xs leading-5 text-foreground"
                    >
                      {command}
                    </pre>
                  </dd>
                </div>
              )
            })}
          </dl>
        </div>
      ))}
    </PluginReviewSection>
  )
}
