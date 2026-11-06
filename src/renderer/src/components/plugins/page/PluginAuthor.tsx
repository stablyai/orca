import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'
import type { PluginAuthor } from '../presentation/plugin-author'
import { DetailSection } from './PluginDetailSections'
import { Button } from '../../ui/button'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

export function PluginAuthorByline({ author }: { author: PluginAuthor }): React.JSX.Element {
  return (
    <span className="min-w-0">
      {author.catalog
        ? translate(
            'auto.components.settings.PluginAuthor.catalogByline',
            'Listed as {{publisher}} by {{catalog}}',
            { publisher: author.publisher, catalog: author.catalog }
          )
        : author.provenance === 'manifest'
          ? translate(
              'auto.components.settings.PluginAuthor.declaredByline',
              'Declared publisher: {{publisher}}',
              { publisher: author.publisher }
            )
          : translate(
              'auto.components.settings.PluginAuthor.publisherByline',
              'Publisher: {{publisher}}',
              {
                publisher: author.publisher
              }
            )}
    </span>
  )
}

function pluginAuthorClaim(author: PluginAuthor): string {
  switch (author.provenance) {
    case 'catalog':
      return author.catalog
        ? translate(
            'auto.components.settings.PluginAuthor.catalogClaim',
            'Publisher listed by {{catalog}}. Authorship is not verified.',
            { catalog: author.catalog }
          )
        : translate(
            'auto.components.settings.PluginAuthor.unnamedCatalogClaim',
            'Publisher listed by the catalog. Authorship is not verified.'
          )
    case 'git':
      return translate(
        'auto.components.settings.PluginAuthor.gitClaim',
        'Publisher derived by Orca from the repository URL. Authorship is not verified.'
      )
    case 'manifest':
      return translate(
        'auto.components.settings.PluginAuthor.manifestClaim',
        'Publisher declared by the plugin. Authorship is not verified.'
      )
    case 'unknown':
      return translate(
        'auto.components.settings.PluginAuthor.unknownClaim',
        'Publisher source is unknown. Authorship is not verified.'
      )
  }
}

export function PluginAuthorCard({
  author,
  pluginCount,
  profileUrl
}: {
  author: PluginAuthor
  /** Displayed matches, including this plugin; null when catalog scope is unknown. */
  pluginCount: number | null
  profileUrl: string | null
}): React.JSX.Element {
  return (
    <section
      data-plugin-author=""
      className="rounded-xl border border-border/50 bg-card/50 p-3.5 shadow-xs"
    >
      <h3 className="text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {translate('auto.components.settings.PluginAuthor.publisher', 'Publisher')}
      </h3>
      <p className="mt-3 truncate text-sm font-semibold" title={author.publisher}>
        {profileUrl ? (
          <Button
            variant="link"
            size="inline"
            className="max-w-full"
            onClick={(event) => openAppHttpLink(profileUrl, { event })}
          >
            <span className="truncate">{author.publisher}</span>
            <ArrowUpRight className="shrink-0" />
          </Button>
        ) : (
          author.publisher
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{pluginAuthorClaim(author)}</p>
      {pluginCount !== null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PluginAuthor.shownPluginCount',
            '{{count}} matching plugins shown, including this one',
            {
              count: pluginCount,
              defaultValue_one: '{{count}} matching plugin shown, including this one'
            }
          )}
        </p>
      ) : null}
    </section>
  )
}

/** Other displayed listings using the same publisher label in this catalog. */
export function PluginMoreFromAuthor({
  author,
  plugins,
  onOpenPlugin
}: {
  author: PluginAuthor
  plugins: readonly PluginListEntry[]
  onOpenPlugin: (pluginKey: string) => void
}): React.JSX.Element | null {
  if (plugins.length === 0) {
    return null
  }
  return (
    <DetailSection
      title={translate(
        'auto.components.settings.PluginAuthor.samePublisher',
        'More listed as {{value0}}',
        {
          value0: author.publisher
        }
      )}
      count={String(plugins.length)}
    >
      {plugins.map((plugin) => (
        <button
          key={plugin.pluginKey}
          type="button"
          className={cn(
            'flex w-full items-center gap-3 border-t border-border px-3.5 py-2.5 text-left outline-none first:border-t-0',
            'hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
          )}
          onClick={() => onOpenPlugin(plugin.pluginKey)}
        >
          <PluginRowArt entry={plugin} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{plugin.name}</span>
            {plugin.description ? (
              <span className="block truncate text-xs text-muted-foreground">
                {plugin.description}
              </span>
            ) : null}
          </span>
          {plugin.installed ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {translate('auto.components.settings.PluginManager.installed', 'Installed')}
            </span>
          ) : null}
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      ))}
    </DetailSection>
  )
}
