import { AlertTriangle } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'

type LinkRoutePreview = NonNullable<PluginHostListEntry['linkRoutes']>[number]

// Why: same destination vocabulary as the Link Routing setting (browser-link-routing-copy.ts).
function destinationLabel(destination: LinkRoutePreview['destination']): string {
  switch (destination) {
    case 'orca-browser':
      return translate(
        'auto.components.settings.PluginLinkRouteConsentPreview.orcaBrowser',
        "Opens in Orca's built-in browser"
      )
    case 'system-browser':
      return translate(
        'auto.components.settings.PluginLinkRouteConsentPreview.systemBrowser',
        'Opens in your system browser'
      )
  }
}

export function PluginLinkRouteConsentPreview({
  routes
}: {
  routes: readonly LinkRoutePreview[]
}): React.JSX.Element | null {
  if (routes.length === 0) {
    return null
  }
  return (
    <section className="space-y-3" aria-labelledby="plugin-link-route-consent-heading">
      <h3
        id="plugin-link-route-consent-heading"
        className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"
      >
        {translate(
          'auto.components.settings.PluginLinkRouteConsentPreview.heading',
          'Link destinations'
        )}
      </h3>
      {routes.map((route) => (
        <div
          key={`${route.hostname}:${route.destination}`}
          className="space-y-1 rounded-md border border-border p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-xs text-foreground">{route.hostname}</span>
            <span className="text-xs text-muted-foreground">
              {destinationLabel(route.destination)}
            </span>
          </div>
          {route.description ? (
            <p className="text-xs leading-5 text-muted-foreground">{route.description}</p>
          ) : null}
          {route.conflict ? (
            <p className="flex items-start gap-1.5 text-xs leading-5 text-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {translate(
                  'auto.components.settings.PluginLinkRouteConsentPreview.conflict',
                  'Another plugin already claims this hostname, so this route stays inactive.'
                )}
              </span>
            </p>
          ) : null}
        </div>
      ))}
    </section>
  )
}
