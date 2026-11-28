import { describe, expect, it } from 'vitest'
import { findImportNavigationRequest, scanImportStatements } from './import-statement-scan'

const SOURCE = `// import { stale } from './old'
import Chart, * as charts from "./chart"
import {
  useTrend as useTrendData,
  type TrendPoint,
} from '../api'
const lazy = () => import('./lazy-panel')
const sample = "import { fake } from './fake-module'"
`

function requestAt(cursor: string, definition?: string) {
  return findImportNavigationRequest(
    scanImportStatements(SOURCE),
    SOURCE.indexOf(cursor),
    definition === undefined ? [] : [SOURCE.indexOf(definition)]
  )
}

describe('findImportNavigationRequest', () => {
  it('maps a definition that lands on an import binding to its module and exported name', () => {
    expect(requestAt('useTrendData,', 'useTrendData,')).toEqual({
      specifier: '../api',
      importedName: 'useTrend'
    })
    expect(requestAt('TrendPoint', 'TrendPoint')).toEqual({
      specifier: '../api',
      importedName: 'TrendPoint'
    })
    expect(requestAt('Chart,', 'Chart,')).toEqual({ specifier: './chart', importedName: 'default' })
    expect(requestAt('charts', 'charts')).toEqual({ specifier: './chart', importedName: '*' })
  })

  it('opens the module when the cursor is on a path, including dynamic imports', () => {
    expect(requestAt("'../api'")).toEqual({ specifier: '../api', importedName: null })
    expect(requestAt('lazy-panel')).toEqual({ specifier: './lazy-panel', importedName: null })
  })

  it('ignores commented-out imports, imports quoted inside strings, and other definitions', () => {
    expect(requestAt('old', 'stale')).toBeNull()
    expect(requestAt('fake-module', 'fake')).toBeNull()
    expect(requestAt('lazy =', 'lazy =')).toBeNull()
  })
})
