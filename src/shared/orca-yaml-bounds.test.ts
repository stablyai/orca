import { afterEach, describe, expect, it, vi } from 'vitest'
import { Document, stringify } from 'yaml'
import {
  MAX_ORCA_YAML_ALIAS_COUNT,
  MAX_ORCA_YAML_BYTES,
  MAX_ORCA_YAML_COLLECTION_ENTRIES,
  MAX_ORCA_YAML_FIELD_BYTES,
  MAX_ORCA_YAML_FIELD_CODE_UNITS
} from './orca-yaml-file-limit'
import { parseOrcaYaml } from './orca-yaml'

afterEach(() => vi.restoreAllMocks())

describe('orca.yaml parse bounds', () => {
  it('admits the exact UTF-8 input boundary and rejects +1 before conversion', () => {
    const toJS = vi.spyOn(Document.prototype, 'toJS')
    const prefix = 'scripts:\n  setup: pnpm install\n#'
    const exact = prefix + ' '.repeat(MAX_ORCA_YAML_BYTES - prefix.length)
    expect(parseOrcaYaml(exact)).toMatchObject({ scripts: { setup: 'pnpm install' } })
    expect(toJS).toHaveBeenCalledOnce()
    toJS.mockClear()
    expect(parseOrcaYaml(`${exact} `)).toBeNull()
    expect(toJS).not.toHaveBeenCalled()
  })

  it('rejects a multibyte input over the byte cap before conversion', () => {
    const toJS = vi.spyOn(Document.prototype, 'toJS')
    expect(parseOrcaYaml('é'.repeat(MAX_ORCA_YAML_BYTES / 2 + 1))).toBeNull()
    expect(toJS).not.toHaveBeenCalled()
  })

  it('passes an explicit alias expansion cap to YAML conversion', () => {
    const toJS = vi.spyOn(Document.prototype, 'toJS')
    expect(parseOrcaYaml('scripts:\n  setup: pnpm install')).not.toBeNull()
    expect(toJS).toHaveBeenCalledWith({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  })

  it('preserves exact-size fields and drops a field at +1 code unit', () => {
    const exact = 'x'.repeat(MAX_ORCA_YAML_FIELD_CODE_UNITS)
    expect(parseOrcaYaml(stringify({ scripts: { setup: exact } }))).toMatchObject({
      scripts: { setup: exact }
    })
    expect(parseOrcaYaml(stringify({ scripts: { setup: `${exact}x` } }))).toBeNull()
    const exactUtf8 = 'é'.repeat(MAX_ORCA_YAML_FIELD_BYTES / 2)
    expect(parseOrcaYaml(stringify({ scripts: { setup: exactUtf8 } }))).toMatchObject({
      scripts: { setup: exactUtf8 }
    })
    expect(parseOrcaYaml(stringify({ scripts: { setup: `${exactUtf8}é` } }))).toBeNull()
  })

  it('admits the exact collection boundary and rejects +1 entries', () => {
    const tabs = Array.from({ length: MAX_ORCA_YAML_COLLECTION_ENTRIES }, (_, index) => ({
      title: `tab-${index}`
    }))
    expect(parseOrcaYaml(stringify({ defaultTabs: tabs }))?.defaultTabs).toHaveLength(
      MAX_ORCA_YAML_COLLECTION_ENTRIES
    )
    expect(parseOrcaYaml(stringify({ defaultTabs: [...tabs, { title: 'overflow' }] }))).toBeNull()
  })
})
