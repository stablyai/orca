import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'
import {
  parsePluginSettingValue,
  pluginSettingContributionSchema
} from './plugin-settings-contribution'

function manifest(settings: unknown[], capabilities = [{ kind: 'settings:own' }]) {
  return parsePluginManifest({
    manifestVersion: 1,
    id: 'roadmap',
    publisher: 'orca-samples',
    name: 'Roadmap',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { settings },
    capabilities
  })
}

const SORT = {
  key: 'sort',
  title: 'Sort by',
  type: 'enum',
  default: 'updated',
  options: [
    { value: 'updated', label: 'Updated' },
    { value: 'priority', label: 'Priority' }
  ]
}

describe('settings contributions', () => {
  it('accepts string, boolean and enum settings with the settings:own capability', () => {
    const result = manifest([
      SORT,
      { key: 'listName', title: 'List name', type: 'string', default: 'Backlog', multiline: false },
      { key: 'showDone', title: 'Show done', type: 'boolean', default: false }
    ])

    expect(result).toMatchObject({ ok: true })
  })

  it('requires settings:own and unique keys', () => {
    expect(manifest([SORT], [])).toEqual({
      ok: false,
      error: 'capabilities: settings:own capability required when contributes.settings is non-empty'
    })
    expect(manifest([SORT, SORT])).toEqual({
      ok: false,
      error: 'contributes.settings.1: duplicate settings key: sort'
    })
  })

  it('rejects declarations whose default, options or type disagree', () => {
    const invalid = [
      { ...SORT, options: undefined },
      { ...SORT, default: 'nowhere' },
      { key: 'flag', title: 'Flag', type: 'boolean', default: 'yes' },
      { key: 'name', title: 'Name', type: 'string', options: SORT.options },
      { key: 'flag', title: 'Flag', type: 'boolean', multiline: true },
      { key: '1bad', title: 'Bad', type: 'string' }
    ]

    for (const setting of invalid) {
      expect(pluginSettingContributionSchema.safeParse(setting).success).toBe(false)
    }
  })
})

describe('parsePluginSettingValue', () => {
  it('keeps values that fit the declaration and rejects the rest', () => {
    const sort = pluginSettingContributionSchema.parse(SORT)
    const flag = pluginSettingContributionSchema.parse({
      key: 'flag',
      title: 'Flag',
      type: 'boolean'
    })

    expect(parsePluginSettingValue(sort, 'priority')).toBe('priority')
    expect(parsePluginSettingValue(sort, 'elsewhere')).toBeNull()
    expect(parsePluginSettingValue(flag, true)).toBe(true)
    expect(parsePluginSettingValue(flag, 'true')).toBeNull()
  })
})
