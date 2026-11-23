// An app's one line in the Add and Connectors lists, in the UI language, keyed by its id; the
// catalogs keep the English. Composio slugs get their own keys: an app listed both ways says different things.
import type { ComposioCuratedApp } from '../composio/composio-curated-apps'
import type { BotMcpApp } from './bot-mcp-apps'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function botMcpAppLine(app: Pick<BotMcpApp, 'id' | 'line'>, t: Translate): string {
  return t(`bots.apps.line.${app.id}`, app.line)
}

export function composioCuratedAppLine(
  app: Pick<ComposioCuratedApp, 'slug' | 'line'>,
  t: Translate
): string {
  return t(`bots.apps.composioLine.${app.slug}`, app.line)
}
