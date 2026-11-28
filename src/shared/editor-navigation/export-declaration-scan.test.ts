import { describe, expect, it } from 'vitest'
import { findExportDeclaration, findStarReexports } from './export-declaration-scan'

const SOURCE = [
  "import { helper } from './helper'",
  'function TrendChart() {}',
  'export function useTrend() {}',
  'export const periodTotal = () => 0',
  'export default class Panel {}',
  'export type TrendRange = 7 | 30',
  'export { TrendChart, helper as assist }',
  "export { changeRate as rate } from './calc'",
  "export * from './more'"
].join('\n')

describe('findExportDeclaration', () => {
  it('finds a directly exported declaration', () => {
    expect(findExportDeclaration(SOURCE, 'useTrend')).toEqual({
      kind: 'declaration',
      offset: SOURCE.indexOf('useTrend')
    })
    expect(findExportDeclaration(SOURCE, 'TrendRange')).toEqual({
      kind: 'declaration',
      offset: SOURCE.indexOf('TrendRange')
    })
  })

  it('finds the default export', () => {
    expect(findExportDeclaration(SOURCE, 'default')).toEqual({
      kind: 'declaration',
      offset: SOURCE.indexOf('export default')
    })
  })

  it('follows an export list to the local declaration', () => {
    expect(findExportDeclaration(SOURCE, 'TrendChart')).toEqual({
      kind: 'declaration',
      offset: SOURCE.indexOf('TrendChart')
    })
  })

  it('reports an imported name re-exported under an alias', () => {
    expect(findExportDeclaration(SOURCE, 'assist')).toEqual({
      kind: 'reexport',
      specifier: './helper',
      exportName: 'helper'
    })
  })

  it('reports a re-export from another module with its original name', () => {
    expect(findExportDeclaration(SOURCE, 'rate')).toEqual({
      kind: 'reexport',
      specifier: './calc',
      exportName: 'changeRate'
    })
  })

  it('ignores commented-out exports', () => {
    const source =
      "// export const rate = 0\n// export * from './old'\nexport * from './new'\nexport const rate = 1\n"
    expect(findExportDeclaration(source, 'rate')).toEqual({
      kind: 'declaration',
      offset: source.lastIndexOf('rate')
    })
    expect(findStarReexports(source)).toEqual(['./new'])
  })

  it('returns null for a name the file does not export and lists star re-exports', () => {
    expect(findExportDeclaration(SOURCE, 'missing')).toBeNull()
    expect(findStarReexports(SOURCE)).toEqual(['./more'])
  })
})
