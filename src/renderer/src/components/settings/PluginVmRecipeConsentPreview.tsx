import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'

type VmRecipePreview = NonNullable<PluginHostListEntry['vmRecipes']>[number]

function lifecycleLabel(phase: VmRecipePreview['commands'][number]['phase']): string {
  switch (phase) {
    case 'create':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.create', 'Create')
    case 'suspend':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.suspend', 'Suspend')
    case 'resume':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.resume', 'Resume')
    case 'destroy':
      return translate('auto.components.settings.PluginVmRecipeConsentPreview.destroy', 'Destroy')
  }
}

export function PluginVmRecipeConsentPreview({
  recipes
}: {
  recipes: readonly VmRecipePreview[]
}): React.JSX.Element | null {
  if (recipes.length === 0) {
    return null
  }
  return (
    <section className="space-y-3" aria-labelledby="plugin-vm-recipe-consent-heading">
      <h3
        id="plugin-vm-recipe-consent-heading"
        className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"
      >
        {translate(
          'auto.components.settings.PluginVmRecipeConsentPreview.heading',
          'VM recipe commands'
        )}
      </h3>
      {recipes.map((recipe) => (
        <div key={recipe.id} className="space-y-2 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium">{recipe.name}</p>
            {recipe.description ? (
              <p className="text-xs leading-5 text-muted-foreground">{recipe.description}</p>
            ) : null}
          </div>
          <dl className="space-y-2">
            {recipe.commands.map(({ phase, command }) => {
              const phaseLabel = lifecycleLabel(phase)
              return (
                <div key={phase}>
                  <dt className="mb-1 text-xs text-muted-foreground">{phaseLabel}</dt>
                  <dd>
                    <pre
                      tabIndex={0}
                      aria-label={translate(
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
    </section>
  )
}
