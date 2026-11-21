import { describe, expect, it } from 'vitest'
import { findImportReferenceAt } from './import-reference-scan'

const SOURCE = [
  'import { Badge, Text as Label } from "@acme/ui";',
  "import Default, * as Space from './x'",
  'import type {',
  '  TrendRange,',
  '  type TrendMetric',
  "} from '../types'",
  "export { changeRate as rate } from '../calc'",
  "const lazy = () => import('./Lazy')",
  'const value = 1'
].join('\n')

const at = (needle: string, delta = 0): number => SOURCE.indexOf(needle) + delta

describe('findImportReferenceAt', () => {
  it('maps a named binding to its module and exported name', () => {
    expect(findImportReferenceAt(SOURCE, at('Badge'))).toEqual({
      specifier: '@acme/ui',
      exportName: 'Badge'
    })
  })

  it('uses the exported name, not the local alias', () => {
    expect(findImportReferenceAt(SOURCE, at('Label'))).toEqual({
      specifier: '@acme/ui',
      exportName: 'Text'
    })
  })

  it('maps default and namespace bindings', () => {
    expect(findImportReferenceAt(SOURCE, at('Default'))).toEqual({
      specifier: './x',
      exportName: 'default'
    })
    expect(findImportReferenceAt(SOURCE, at('Space'))).toEqual({
      specifier: './x',
      exportName: '*'
    })
  })

  it('reads multi-line type imports', () => {
    expect(findImportReferenceAt(SOURCE, at('TrendMetric'))).toEqual({
      specifier: '../types',
      exportName: 'TrendMetric'
    })
  })

  it('maps the module specifier string to the module itself', () => {
    expect(findImportReferenceAt(SOURCE, at('../types', 2))).toEqual({
      specifier: '../types',
      exportName: '*'
    })
    expect(findImportReferenceAt(SOURCE, at('./Lazy', 2))).toEqual({
      specifier: './Lazy',
      exportName: '*'
    })
  })

  it('follows a re-export clause to the original name', () => {
    expect(findImportReferenceAt(SOURCE, at('rate'))).toEqual({
      specifier: '../calc',
      exportName: 'changeRate'
    })
  })

  it('ignores commented-out imports', () => {
    const source = "// import { Old } from './old'\n/* import { Older } from './older' */\n"
    expect(findImportReferenceAt(source, source.indexOf('Old'))).toBeNull()
    expect(findImportReferenceAt(source, source.indexOf('Older'))).toBeNull()
  })

  it('reads elements with comments, non-ASCII names and a name called type', () => {
    const source = "import { /* note */ Chart, café, type as kind } from './x'"
    const name = (needle: string): string | undefined =>
      findImportReferenceAt(source, source.indexOf(needle))?.exportName
    expect([name('Chart'), name('café'), name('kind')]).toEqual(['Chart', 'café', 'type'])
  })

  it('answers only module specifiers when asked to', () => {
    const options = { specifierOnly: true }
    expect(findImportReferenceAt(SOURCE, at('Badge'), options)).toBeNull()
    expect(findImportReferenceAt(SOURCE, at('@acme/ui', 2), options)).toEqual({
      specifier: '@acme/ui',
      exportName: '*'
    })
  })

  it('returns null outside import declarations', () => {
    expect(findImportReferenceAt(SOURCE, at('value'))).toBeNull()
  })
})
