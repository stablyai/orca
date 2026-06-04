import { describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'
import type { CodeIntelResult } from '../../../shared/code-intel-contract'

vi.mock('monaco-editor', () => {
  class Range {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
    constructor(sln: number, sc: number, eln: number, ec: number) {
      this.startLineNumber = sln
      this.startColumn = sc
      this.endLineNumber = eln
      this.endColumn = ec
    }
  }
  const Uri = {
    file: (path: string) => ({ path, toString: () => path })
  }
  return { default: {}, Range, Uri }
})

import {
  buildReferenceRequest,
  toMonacoLocations,
  getImportStringRange,
  isStaleResult
} from './monaco-code-intel-providers'

describe('monaco-code-intel-providers', () => {
  it('converts a Monaco 1-based position to a 0-based contract position', () => {
    const request = buildReferenceRequest({
      worktreeRoot: '/repo',
      filePath: '/repo/src/a.ts',
      monacoPosition: { lineNumber: 3, column: 5 },
      bufferText: 'x',
      bufferVersion: 4,
      connectionId: undefined
    })
    expect(request.position).toEqual({ line: 2, character: 4 })
    expect(request.relativePath).toBe('src/a.ts')
    expect(request.bufferVersion).toBe(4)
  })

  it('omits buffer text for a clean file so the sidecar reads it from disk', () => {
    const request = buildReferenceRequest({
      worktreeRoot: '/repo',
      filePath: '/repo/src/a.ts',
      monacoPosition: { lineNumber: 1, column: 1 },
      bufferText: 'whole file contents',
      bufferVersion: 1,
      isDirty: false
    })
    expect(request.bufferText).toBeUndefined()
  })

  it('converts a 0-based contract location to a 1-based Monaco range', () => {
    const locations = toMonacoLocations({
      status: 'ok',
      bufferVersion: 1,
      truncated: false,
      locations: [
        {
          absolutePath: '/pkg/src/a.ts',
          relativePath: 'src/a.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }
        }
      ]
    })
    expect(locations).toHaveLength(1)
    expect(locations[0].range.startLineNumber).toBe(1)
    expect(locations[0].range.startColumn).toBe(1)
    expect(locations[0].range.endColumn).toBe(4)
    // Why: the absolute path is used verbatim, not reconstructed from a worktree
    // root — so a project root below the worktree (monorepo) resolves correctly.
    expect(locations[0].uri.path).toBe('/pkg/src/a.ts')
  })

  it('returns no Monaco locations for an unsupported result', () => {
    expect(toMonacoLocations({ status: 'unsupported', reason: 'remote-runtime' })).toEqual([])
  })

  describe('isStaleResult', () => {
    const okAtVersion = (bufferVersion: number): CodeIntelResult => ({
      status: 'ok',
      bufferVersion,
      truncated: false,
      locations: []
    })

    it('is stale when the buffer advanced past the version the result was computed against', () => {
      expect(isStaleResult(okAtVersion(4), 5)).toBe(true)
    })

    it('is fresh when the buffer version still matches', () => {
      expect(isStaleResult(okAtVersion(4), 4)).toBe(false)
    })

    it('never flags a non-ok result as stale', () => {
      expect(isStaleResult({ status: 'unsupported', reason: 'remote-runtime' }, 99)).toBe(false)
    })
  })

  describe('getImportStringRange', () => {
    const makeModel = (line: string): monaco.editor.ITextModel =>
      ({
        getLineContent: (n: number) => (n === 1 ? line : ''),
        getValue: () => line,
        getVersionId: () => 1
      }) as unknown as monaco.editor.ITextModel

    it('highlights the path content inside quotes for "from" import with single quotes', () => {
      const model = makeModel("import { foo } from './bar'")
      const result = getImportStringRange(model, { lineNumber: 1, column: 23 })
      expect(result).toBeDefined()
      expect(result!.startLineNumber).toBe(1)
      expect(result!.startColumn).toBe(22)
      expect(result!.endColumn).toBe(27)
    })

    it('highlights the path content inside quotes for "from" import with double quotes', () => {
      const model = makeModel('import { foo } from "./bar"')
      const result = getImportStringRange(model, { lineNumber: 1, column: 23 })
      expect(result).toBeDefined()
      expect(result!.startColumn).toBe(22)
      expect(result!.endColumn).toBe(27)
    })

    it('highlights the path content for bare import', () => {
      const model = makeModel("import './styles.css'")
      const result = getImportStringRange(model, { lineNumber: 1, column: 10 })
      expect(result).toBeDefined()
      expect(result!.startColumn).toBe(9)
      expect(result!.endColumn).toBe(21)
    })

    it('returns null when cursor is outside the import string', () => {
      const model = makeModel("import { foo } from './bar'")
      const result = getImportStringRange(model, { lineNumber: 1, column: 5 })
      expect(result).toBeNull()
    })

    it('returns null for non-import lines', () => {
      const model = makeModel('const x = 1')
      const result = getImportStringRange(model, { lineNumber: 1, column: 5 })
      expect(result).toBeNull()
    })
  })
})
