import { describe, expect, it } from 'vitest'
import {
  buildImportTargetCandidates,
  findImportSpecifierLinkAt,
  getImportSpecifierLinks,
  supportsImportSpecifierLinks
} from './import-specifier-links'
import { parseTsconfigPathAliases } from './tsconfig-path-aliases'

describe('supportsImportSpecifierLinks', () => {
  it('accepts the Monaco ts/js language ids and rejects the rest', () => {
    expect(supportsImportSpecifierLinks('typescript')).toBe(true)
    expect(supportsImportSpecifierLinks('javascript')).toBe(true)
    expect(supportsImportSpecifierLinks('markdown')).toBe(false)
    expect(supportsImportSpecifierLinks('python')).toBe(false)
  })
})

describe('getImportSpecifierLinks', () => {
  it('links the module specifier and the imported binding of a named import', () => {
    expect(getImportSpecifierLinks('import { cn } from "@utils/cn"')).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 21, endLineNumber: 1, endColumn: 30 },
        specifier: '@utils/cn'
      },
      {
        range: { startLineNumber: 1, startColumn: 10, endLineNumber: 1, endColumn: 12 },
        specifier: '@utils/cn'
      }
    ])
  })

  it('links every binding of a prettier-wrapped multi-line import', () => {
    const links = getImportSpecifierLinks("import {\n  a,\n  b as c\n} from './mod'")
    expect(links).toEqual([
      {
        range: { startLineNumber: 4, startColumn: 9, endLineNumber: 4, endColumn: 14 },
        specifier: './mod'
      },
      {
        range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 4 },
        specifier: './mod'
      },
      {
        range: { startLineNumber: 3, startColumn: 3, endLineNumber: 3, endColumn: 4 },
        specifier: './mod'
      },
      {
        range: { startLineNumber: 3, startColumn: 8, endLineNumber: 3, endColumn: 9 },
        specifier: './mod'
      }
    ])
  })

  it('skips the type keyword but keeps the binding of a type-only import', () => {
    const links = getImportSpecifierLinks("import type { X } from './x'")
    expect(links.map((link) => [link.specifier, link.range.startColumn])).toEqual([
      ['./x', 25],
      ['./x', 15]
    ])
  })

  it('links side-effect, dynamic import, and require specifiers', () => {
    expect(getImportSpecifierLinks("import './styles.css'")).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 21 },
        specifier: './styles.css'
      }
    ])
    expect(getImportSpecifierLinks("const m = await import('./z')")).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 25, endLineNumber: 1, endColumn: 28 },
        specifier: './z'
      }
    ])
    expect(getImportSpecifierLinks("const y = require('./y')")).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 20, endLineNumber: 1, endColumn: 23 },
        specifier: './y'
      }
    ])
  })

  it('links re-export bindings and skips the as keyword', () => {
    const links = getImportSpecifierLinks("export { a as b } from './a'")
    expect(links.map((link) => link.specifier)).toEqual(['./a', './a', './a'])
    expect(links.map((link) => link.range.startColumn)).toEqual([25, 10, 15])
  })

  it('returns nothing for content without imports', () => {
    expect(getImportSpecifierLinks('const from = 1\nlet importCount = 2')).toEqual([])
  })

  it('ignores import-like text inside comments and string literals', () => {
    const content = [
      "// import { line } from './line-comment'",
      "/* require('./block-comment') */",
      `const quoted = "import('./quoted')"`,
      "const templated = `export { value } from './template'`",
      "import { live /* ignored binding */ } from './live'"
    ].join('\n')

    expect(getImportSpecifierLinks(content).map((link) => link.specifier)).toEqual([
      './live',
      './live'
    ])
  })

  it('scans code inside nested template expressions without linking template text', () => {
    const content = [
      "const nested = `outer ${flag ? `fake import('./nested-fake')` : await import('./nested-real')}`",
      "const deep = `outer ${`middle ${await import('./deep-real')}`}`",
      "const escaped = `text \\` fake require('./escaped-fake')`",
      "const escapedExpression = `text \\${import('./escaped-expression-fake')}`",
      "const braced = `outer ${(() => { /* } import('./comment-fake') */ return import('./braced-real') })()}`",
      "const after = import('./after')"
    ].join('\n')

    expect(getImportSpecifierLinks(content).map((link) => link.specifier)).toEqual([
      './nested-real',
      './deep-real',
      './braced-real',
      './after'
    ])
  })
})

describe('findImportSpecifierLinkAt', () => {
  const links = getImportSpecifierLinks('import { cn } from "@utils/cn"')

  it('hits inside a link range, inclusive of both edges', () => {
    expect(findImportSpecifierLinkAt(links, { lineNumber: 1, column: 21 })?.specifier).toBe(
      '@utils/cn'
    )
    expect(findImportSpecifierLinkAt(links, { lineNumber: 1, column: 30 })?.specifier).toBe(
      '@utils/cn'
    )
    expect(findImportSpecifierLinkAt(links, { lineNumber: 1, column: 11 })?.specifier).toBe(
      '@utils/cn'
    )
  })

  it('misses outside link ranges', () => {
    expect(findImportSpecifierLinkAt(links, { lineNumber: 1, column: 1 })).toBeNull()
    expect(findImportSpecifierLinkAt(links, { lineNumber: 2, column: 21 })).toBeNull()
  })
})

describe('parseTsconfigPathAliases', () => {
  it('parses baseUrl and paths through comments and trailing commas', () => {
    const text = `{
      // path aliases
      "compilerOptions": {
        "baseUrl": ".", /* block */
        "paths": {
          "@utils/*": ["src/utils/*"],
        },
      },
    }`
    expect(parseTsconfigPathAliases(text)).toEqual({
      baseUrl: '.',
      paths: { '@utils/*': ['src/utils/*'] }
    })
  })

  it('ignores malformed path entries and keeps valid ones', () => {
    const text = '{"compilerOptions":{"paths":{"@a/*":["src/a/*"],"@bad":"not-an-array"}}}'
    expect(parseTsconfigPathAliases(text)).toEqual({
      baseUrl: null,
      paths: { '@a/*': ['src/a/*'] }
    })
  })

  it('returns null for unparseable json or missing compilerOptions', () => {
    expect(parseTsconfigPathAliases('not json')).toBeNull()
    expect(parseTsconfigPathAliases('{"compilerOptions":{"baseUrl":"src",')).toBeNull()
    expect(parseTsconfigPathAliases('{"include":["src"]}')).toBeNull()
  })

  it('preserves comment-like text and escaped quotes inside jsonc strings', () => {
    const text = String.raw`{"compilerOptions":{"baseUrl":"src//literal","paths":{"@quoted/*":["say-\"hi\"/*"]}}}`
    expect(parseTsconfigPathAliases(text)).toEqual({
      baseUrl: 'src//literal',
      paths: { '@quoted/*': ['say-"hi"/*'] }
    })
  })
})

describe('buildImportTargetCandidates', () => {
  it('resolves relative specifiers against the source directory with extension probes', () => {
    const candidates = buildImportTargetCandidates('./cn', '/repo/src/lib/x.ts', '/repo', null)
    expect(candidates[0]).toBe('/repo/src/lib/cn')
    expect(candidates).toContain('/repo/src/lib/cn.ts')
    expect(candidates).toContain('/repo/src/lib/cn/index.ts')
  })

  it('collapses parent segments in relative specifiers', () => {
    const candidates = buildImportTargetCandidates('../a', '/repo/src/lib/x.ts', '/repo', null)
    expect(candidates[0]).toBe('/repo/src/a')
  })

  it('collapses parent segments on windows-style paths', () => {
    const candidates = buildImportTargetCandidates(
      '../a',
      'C:\\repo\\src\\lib\\x.ts',
      'C:\\repo',
      null
    )
    expect(candidates[0]).toBe('C:\\repo\\src\\a')
  })

  it('maps tsconfig path aliases relative to baseUrl', () => {
    const candidates = buildImportTargetCandidates('@utils/cn', '/repo/src/x.ts', '/repo', {
      baseUrl: '.',
      paths: { '@utils/*': ['src/utils/*'] }
    })
    expect(candidates).toContain('/repo/src/utils/cn.ts')
  })

  it('uses only the first matching alias pattern, exact patterns first', () => {
    const candidates = buildImportTargetCandidates('@utils/cn', '/repo/src/x.ts', '/repo', {
      baseUrl: null,
      paths: { '@utils/*': ['src/wildcard/*'], '@utils/cn': ['src/exact/cn.ts'] }
    })
    expect(candidates[0]).toBe('/repo/src/exact/cn.ts')
    expect(candidates.some((candidate) => candidate.includes('wildcard'))).toBe(false)
  })

  it('falls back to src/<alias> and <alias> conventions when tsconfig has no match', () => {
    const candidates = buildImportTargetCandidates('@utils/cn', '/repo/src/x.ts', '/repo', null)
    expect(candidates[0]).toBe('/repo/src/utils/cn')
    expect(candidates).toContain('/repo/src/utils/cn.ts')
    expect(candidates).toContain('/repo/utils/cn.ts')
  })

  it('skips bare package specifiers', () => {
    expect(buildImportTargetCandidates('react', '/repo/src/x.ts', '/repo', null)).toEqual([])
  })

  it('probes .ts/.tsx sources for NodeNext emitted .js specifiers', () => {
    expect(buildImportTargetCandidates('./cn.js', '/repo/src/x.ts', '/repo', null)).toEqual([
      '/repo/src/cn.js',
      '/repo/src/cn.ts',
      '/repo/src/cn.tsx'
    ])
  })

  it('strips bundler query suffixes before resolving', () => {
    const candidates = buildImportTargetCandidates(
      './logo.svg?raw',
      '/repo/src/x.ts',
      '/repo',
      null
    )
    expect(candidates[0]).toBe('/repo/src/logo.svg')
  })
})
