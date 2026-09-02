import { Search } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Input } from '../ui/input'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

export type PluginCatalogFilter = 'all' | 'installed'

type PluginCatalogLayoutProps = {
  filter: PluginCatalogFilter
  onFilterChange: (filter: PluginCatalogFilter) => void
  search: string
  onSearchChange: (search: string) => void
  allCount: number
  installedCount: number
  toolbar?: React.ReactNode
  children: React.ReactNode
}

/** Shared catalog chrome for both the in-app manager and a future hosted directory. */
export function PluginCatalogLayout({
  filter,
  onFilterChange,
  search,
  onSearchChange,
  allCount,
  installedCount,
  toolbar,
  children
}: PluginCatalogLayoutProps): React.JSX.Element {
  return (
    <section
      aria-label={translate('auto.components.pluginCatalog.PluginCatalogLayout.title', 'Plugins')}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={filter}
          onValueChange={(value) => onFilterChange(value as PluginCatalogFilter)}
        >
          <TabsList
            aria-label={translate(
              'auto.components.pluginCatalog.PluginCatalogLayout.filter',
              'Plugin filter'
            )}
          >
            <TabsTrigger value="all">
              {translate('auto.components.pluginCatalog.PluginCatalogLayout.all', 'All')}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {allCount}
              </span>
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
          </TabsList>
        </Tabs>
        <div className="relative min-w-56 flex-1">
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
              'Search plugins, categories, or publishers'
            )}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
        {toolbar ? <div className="flex items-center gap-1">{toolbar}</div> : null}
      </div>

      {children}
    </section>
  )
}
