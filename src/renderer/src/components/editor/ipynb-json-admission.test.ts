import { describe, expect, it } from 'vitest'
import {
  assertIpynbJsonWithinMemoryLimits,
  assertIpynbShapeWithinMemoryLimits,
  IPYNB_MEMORY_LIMITS,
  type IpynbMemoryLimits
} from './ipynb-json-admission'

function limits(overrides: Partial<IpynbMemoryLimits>): IpynbMemoryLimits {
  return { ...IPYNB_MEMORY_LIMITS, ...overrides }
}

describe('notebook memory admission', () => {
  it('preserves JSON at exact source, structure, and nesting boundaries', () => {
    const content = '{"cells":[]}'
    expect(() =>
      assertIpynbJsonWithinMemoryLimits(
        content,
        limits({ sourceCodeUnits: content.length, structuralTokens: 5, nestingDepth: 2 })
      )
    ).not.toThrow()
  })

  it.each([
    ['source size', '{"cells":[]}', { sourceCodeUnits: 11 }, 'source size'],
    ['JSON structure', '{"cells":[]}', { structuralTokens: 4 }, 'JSON structure'],
    ['JSON nesting', '{"cells":[]}', { nestingDepth: 1 }, 'JSON nesting']
  ] as const)('rejects %s one step past its limit', (_name, content, override, message) => {
    expect(() => assertIpynbJsonWithinMemoryLimits(content, limits(override))).toThrow(message)
  })

  it('ignores structural characters inside strings', () => {
    const content = '{"cells":[{"source":"[{,:}]"}]}'
    expect(() =>
      assertIpynbJsonWithinMemoryLimits(content, limits({ structuralTokens: 9 }))
    ).not.toThrow()
  })

  it.each([
    ['cells', [{}, {}], { cells: 1 }, 'cell'],
    ['outputs', [{ outputs: [{}, {}] }], { outputs: 1 }, 'output'],
    [
      'display items',
      [{ outputs: [{ data: { one: 1, two: 2 } }] }],
      { displayItems: 1 },
      'display item'
    ],
    ['multiline parts', [{ source: ['one', 'two'] }], { multilineParts: 1 }, 'fragment']
  ] as const)('rejects too many %s before render projection', (_name, cells, override, message) => {
    expect(() => assertIpynbShapeWithinMemoryLimits(cells, limits(override))).toThrow(message)
  })
})
