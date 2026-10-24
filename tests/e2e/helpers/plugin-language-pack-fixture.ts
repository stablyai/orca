import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const FIXTURE_LANGUAGE_PLUGIN = {
  repository: 'orca-pseudo-language',
  pluginKey: 'stablyai.orca-pseudo-language',
  name: 'Pseudo Language',
  locale: 'en-XA'
} as const

// Plugin settings copy is protected security text that packs may not replace.
function isProtectedPath(path: string[]): boolean {
  return (
    path.length === 4 &&
    path.slice(0, 3).join('.') === 'auto.components.settings' &&
    /^plugin/i.test(path[3] ?? '')
  )
}

function bracketCatalog(source: Record<string, unknown>, path: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    const childPath = [...path, key]
    if (isProtectedPath(childPath)) {
      continue
    }
    // Why the length check: a few catalog values are style blobs past the per-translation cap.
    if (typeof value === 'string') {
      if (value.length < 4096) {
        result[key] = `[${value}]`
      }
    } else if (typeof value === 'object' && value !== null) {
      result[key] = bracketCatalog(Object.fromEntries(Object.entries(value)), childPath)
    }
  }
  return result
}

/** A complete official language pack built from the English catalog, so it clears the
 *  coverage floor that hides partial packs from the Language picker. */
export async function writeFixtureLanguagePlugin(directory: string): Promise<void> {
  const english: unknown = JSON.parse(
    await readFile(
      join(process.cwd(), 'src', 'renderer', 'src', 'i18n', 'locales', 'en.json'),
      'utf8'
    )
  )
  if (typeof english !== 'object' || english === null) {
    throw new Error('en.json must be an object')
  }
  await mkdir(join(directory, 'locales'), { recursive: true })
  await writeFile(
    join(directory, 'locales', `${FIXTURE_LANGUAGE_PLUGIN.locale}.json`),
    JSON.stringify(bracketCatalog(Object.fromEntries(Object.entries(english)), []))
  )
  await writeFile(
    join(directory, 'orca-plugin.json'),
    `${JSON.stringify(
      {
        manifestVersion: 1,
        id: 'orca-pseudo-language',
        publisher: 'stablyai',
        name: FIXTURE_LANGUAGE_PLUGIN.name,
        version: '1.0.0',
        engines: { orca: '>=1.4.0' },
        pluginApi: 1,
        contributes: {
          languagePacks: [
            {
              locale: FIXTURE_LANGUAGE_PLUGIN.locale,
              path: `locales/${FIXTURE_LANGUAGE_PLUGIN.locale}.json`
            }
          ]
        },
        capabilities: []
      },
      null,
      2
    )}\n`
  )
}
