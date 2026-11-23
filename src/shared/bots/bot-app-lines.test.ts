import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPOSIO_CURATED_APPS } from '../composio/composio-curated-apps'
import { englishTranslate } from '../i18n/english-translate'
import { botMcpAppLine, composioCuratedAppLine } from './bot-app-lines'
import { BOT_MCP_APPS } from './bot-mcp-apps'

const catalog = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), file), 'utf8'))

// The catalog's value at `key`, else the fallback: what i18next does for a key it lacks.
function translatorFor(entries: Record<string, unknown>) {
  const values = new Map<string, string>()
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      values.set(path, node)
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, path ? `${path}.${key}` : key)
      }
    }
  }
  walk(entries, '')
  return (key: string, fallback: string): string => values.get(key) ?? fallback
}

describe('app lines', () => {
  it('ships every app line in the desktop and phone English catalogs, word for word', () => {
    for (const file of [
      'src/renderer/src/i18n/locales/en.json',
      'mobile/src/i18n/locales/en.json'
    ]) {
      const t = translatorFor(catalog(file))
      for (const app of BOT_MCP_APPS) {
        expect(t(`bots.apps.line.${app.id}`, '')).toBe(app.line)
      }
      for (const app of COMPOSIO_CURATED_APPS) {
        expect(t(`bots.apps.composioLine.${app.slug}`, '')).toBe(app.line)
      }
    }
  })

  it('reads a line by its id in the reader’s language, and in English without a catalog', () => {
    const vercel = BOT_MCP_APPS.find((app) => app.id === 'vercel')!
    const notion = COMPOSIO_CURATED_APPS.find((app) => app.slug === 'notion')!
    const german = translatorFor(catalog('src/renderer/src/i18n/locales/de.json'))
    expect(botMcpAppLine(vercel, german)).toBe('Deployments prüfen und ihre Logs lesen')
    expect(composioCuratedAppLine(notion, german)).toBe('Seiten, Datenbanken und Kommentare')
    expect(botMcpAppLine(vercel, englishTranslate)).toBe('Check deployments and read their logs')
    expect(composioCuratedAppLine(notion, translatorFor({}))).toBe('Pages, databases and comments')
  })
})
