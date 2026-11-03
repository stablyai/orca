import { Search, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'

export type PluginCatalogFilter = 'all' | 'installed' | 'available' | 'updates'

type PluginCatalogLayoutProps = {
  filter: PluginCatalogFilter
  onFilterChange: (filter: PluginCatalogFilter) => void
  search: string
  onSearchChange: (search: string) => void
  installedCount: number
  updateCount: number
  toolbar?: React.ReactNode
  /** A row under the search, e.g. the category chips. */
  filters?: React.ReactNode
  children: React.ReactNode
}

function isPluginCatalogFilter(value: string): value is PluginCatalogFilter {
  return value === 'all' || value === 'installed' || value === 'available' || value === 'updates'
}

/** Install-state filter, search and tools above the one plugin list. */
export function PluginCatalogLayout({
  filter,
  onFilterChange,
  search,
  onSearchChange,
  installedCount,
  updateCount,
  toolbar,
  filters,
  children
}: PluginCatalogLayoutProps): React.JSX.Element {
  return (
    <section
      aria-label={translate('auto.components.pluginCatalog.PluginCatalogLayout.title', 'Plugins')}
      className="@container/plugin-list space-y-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={filter}
          onValueChange={(value) => {
            if (isPluginCatalogFilter(value)) {
              onFilterChange(value)
            }
          }}
        >
          <TabsList
            aria-label={translate(
              'auto.components.pluginCatalog.PluginCatalogLayout.filter',
              'Plugin filter'
            )}
          >
            <TabsTrigger value="all">
              {translate('auto.components.pluginCatalog.PluginCatalogLayout.all', 'All')}
            </TabsTrigger>
            <TabsTrigger value="installed">
              {translate(
                'auto.components.pluginCatalog.PluginCatalogLayout.installed',
                'Installed'
              )}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {installedCount}
              </span>
            </TabsTrigger>
            <TabsTrigger value="available">
              {translate(
                'auto.components.pluginCatalog.PluginCatalogLayout.notInstalled',
                'Not installed'
              )}
            </TabsTrigger>
            {updateCount > 0 ? (
              <TabsTrigger value="updates">
                {translate('auto.components.pluginCatalog.PluginCatalogLayout.updates', 'Updates')}
                <span className="text-xs font-normal tabular-nums text-muted-foreground">
                  {updateCount}
                </span>
              </TabsTrigger>
            ) : null}
          </TabsList>
        </Tabs>
        <div className="relative min-w-56 grow @max-xl/plugin-list:order-last @max-xl/plugin-list:basis-full">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            className="pl-9"
            aria-label={translate(
              'auto.components.pluginCatalog.PluginCatalogLayout.searchLabel',
              'Search plugins'
            )}
            placeholder={translate(
              'auto.components.pluginCatalog.PluginCatalogLayout.searchPlaceholder',
              'Search plugins'
            )}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          {search ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-1/2 right-1.5 -translate-y-1/2"
              aria-label={translate(
                'auto.components.pluginCatalog.PluginCatalogLayout.clearSearch',
                'Clear search'
              )}
              onClick={() => onSearchChange('')}
            >
              <X />
            </Button>
          ) : null}
        </div>
        {toolbar ? <div className="ml-auto flex items-center gap-1">{toolbar}</div> : null}
      </div>
      {filters}

      {children}
    </section>
  )
}
