import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PluginTaskFacet } from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceFacetOptions } from '@/store/slices/plugin-task-sources-slice-contract'
import { TaskPagePluginSourceFacetPicker } from './FacetPicker'
import { clearPluginTaskFacet, togglePluginTaskFacetOption } from './facet-selection'

/** The facet controls travel together — they all read the same declaration and
 *  the same selection — so they reach the query bar as one unit. */
export type PluginTaskSourceFacetFilter = {
  facets: PluginTaskFacet[]
  facetOptions: Record<string, PluginTaskSourceFacetOptions>
  facetSelections: Record<string, string[]>
  onFacetSelectionsChange: (facetSelections: Record<string, string[]>) => void
}

export function TaskPagePluginSourceFacetBar({
  facets,
  facetOptions,
  facetSelections,
  onFacetSelectionsChange
}: PluginTaskSourceFacetFilter): React.JSX.Element | null {
  if (facets.length === 0) {
    return null
  }

  const anyActive = facets.some((facet) => (facetSelections[facet.id] ?? []).length > 0)
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={translate('auto.components.TaskPage.pluginTaskSourceFilters', 'Filters')}
    >
      {facets.map((facet) => (
        <TaskPagePluginSourceFacetPicker
          key={facet.id}
          facet={facet}
          options={facetOptions[facet.id] ?? { status: 'loading' }}
          selectedOptionIds={facetSelections[facet.id] ?? []}
          onToggleOption={(optionId) =>
            onFacetSelectionsChange(togglePluginTaskFacetOption(facetSelections, facet, optionId))
          }
          onClear={() => onFacetSelectionsChange(clearPluginTaskFacet(facetSelections, facet.id))}
        />
      ))}
      {anyActive ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onFacetSelectionsChange({})}>
          {translate('auto.components.TaskPage.pluginTaskSourceFacetsClearAll', 'Clear all')}
        </Button>
      ) : null}
    </div>
  )
}
