import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_CAPABILITY_DESCRIPTIONS,
  type PluginCapabilityKind
} from '../../../../../shared/plugins/capabilities/plugin-capabilities'
import { pluginCapabilityDescription } from './plugin-capability-presentation'

type CatalogNode = string | { readonly [key: string]: CatalogNode | undefined }

const englishCatalog: CatalogNode = JSON.parse(
  readFileSync(join(process.cwd(), 'src/renderer/src/i18n/locales/en.json'), 'utf8')
)

function englishCatalogValue(key: string): string {
  const value = key
    .split('.')
    .reduce<CatalogNode | undefined>(
      (node, part) => (typeof node === 'object' ? node[part] : undefined),
      englishCatalog
    )
  return typeof value === 'string' ? value : `missing en.json key ${key}`
}

describe('pluginCapabilityDescription', () => {
  it.each<PluginCapabilityKind>([
    'appearance:write',
    'workspace:create',
    'automation:read',
    'automation:write',
    'history:read'
  ])('renders the shared consent copy for %s from en.json', (kind) => {
    expect(pluginCapabilityDescription(kind, '', englishCatalogValue)).toBe(
      PLUGIN_CAPABILITY_DESCRIPTIONS[kind]
    )
  })
})
