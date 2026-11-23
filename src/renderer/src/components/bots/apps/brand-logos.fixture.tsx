import { defineFixture } from '../../../component-fixtures/component-fixture'
import { BOT_MCP_APPS } from '../../../../../shared/bots/bot-mcp-apps'
import { COMPOSIO_CURATED_APPS } from '../../../../../shared/composio/composio-curated-apps'
import { ComposioAppLogo } from '../composio/ComposioAppLogo'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotAppLogo } from './BotAppRow'

const BRAND_IDS = [
  'slack',
  'google',
  'linear',
  'github',
  ...BOT_MCP_APPS.map((app) => app.id),
  'playwright'
]
const COMPOSIO_SLUGS = [
  'composio',
  ...COMPOSIO_CURATED_APPS.map((app) => app.slug),
  'posthog',
  'supabase',
  'neon',
  'vercel',
  'context7',
  'netlify',
  'playwright'
]

const Cell = ({ name, children }: { name: string; children: React.ReactNode }) => (
  <div className="flex w-24 flex-col items-center gap-1 p-1">
    <div className="flex items-center gap-1.5">{children}</div>
    <span className="truncate text-2xs text-muted-foreground">{name}</span>
  </div>
)

// Every logo the shared resolver draws, at row and chip sizes, to audit tiles on both themes.
export const allLogos = defineFixture({
  width: 980,
  render: () => (
    <div className="flex flex-col gap-3 bg-background p-3">
      <h3 className="text-xs font-semibold">Bundled brands (BotAppBrandLogo)</h3>
      <div className="flex flex-wrap">
        {BRAND_IDS.map((id) => (
          <Cell key={id} name={id}>
            <BotAppBrandLogo app={{ id }} />
            <BotAppBrandLogo app={{ id }} size="sm" />
          </Cell>
        ))}
      </div>
      <h3 className="text-xs font-semibold">Composio logos (BotAppLogo, ComposioAppLogo)</h3>
      <div className="flex flex-wrap">
        {COMPOSIO_SLUGS.map((slug) => (
          <Cell key={slug} name={slug}>
            <BotAppLogo slug={slug} />
            <ComposioAppLogo slug={slug} size="md" />
            <ComposioAppLogo slug={slug} size="sm" />
          </Cell>
        ))}
      </div>
    </div>
  )
})
