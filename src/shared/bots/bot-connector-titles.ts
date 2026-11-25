/** What a connector row's title is made of. */
export type BotConnectorTitleParts = {
  key: string
  /** The service, e.g. GitHub or Notion; rows with the same service are told apart. */
  service: string
  /** The one workspace, org or account the row is bound to, when known. */
  place?: string | null
  /** What else tells the row apart, best first; used only beside rows of the same service. */
  hints?: readonly (string | null | undefined)[]
}

/** "GitHub · stablyai", drawn so a narrow row cuts the service before the name. */
export type BotConnectorTitle = { service: string; name: string | null }

/** The title as one line; `separator` is the translated " · ". */
export function botConnectorTitleLine(
  { service, name }: BotConnectorTitle,
  separator: string
): string {
  return name ? `${service}${separator}${name}` : service
}

/**
 * Every row's title, by key. A row bound to one place (a Slack or Linear workspace, a GitHub org)
 * always names it. When 2+ rows share a service, each also names what tells it apart: its place,
 * else its first hint (via Composio, an app's address) that leaves no two titles the same.
 */
export function botConnectorTitles(
  rows: readonly BotConnectorTitleParts[],
  separator: string
): Map<string, BotConnectorTitle> {
  const byService = new Map<string, BotConnectorTitleParts[]>()
  for (const row of rows) {
    const service = row.service.toLocaleLowerCase()
    byService.set(service, [...(byService.get(service) ?? []), row])
  }
  const titles = new Map<string, BotConnectorTitle>()
  for (const group of byService.values()) {
    for (const [key, title] of groupTitles(group, separator)) {
      titles.set(key, title)
    }
  }
  return titles
}

function groupTitles(
  group: readonly BotConnectorTitleParts[],
  separator: string
): [string, BotConnectorTitle][] {
  const at = (level: number): [string, BotConnectorTitle][] =>
    group.map((row) => [
      row.key,
      {
        service: row.service,
        name: row.place || (group.length > 1 ? hint(row, level) : null)
      }
    ])
  if (group.length === 1) {
    return at(0)
  }
  const levels = Math.max(1, ...group.map((row) => row.hints?.length ?? 0))
  for (let level = 0; level < levels; level++) {
    const titles = at(level)
    const texts = titles.map(([, title]) =>
      botConnectorTitleLine(title, separator).toLocaleLowerCase()
    )
    if (new Set(texts).size === texts.length) {
      return titles
    }
  }
  return at(0)
}

/** The row's hint at `level`, else its last one, so a row with fewer hints keeps its best. */
function hint(row: BotConnectorTitleParts, level: number): string | null {
  const hints = (row.hints ?? []).filter((entry): entry is string => Boolean(entry))
  return hints[Math.min(level, hints.length - 1)] ?? null
}
