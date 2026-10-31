import { describe, expect, it } from 'vitest'
import { pluginSyntaxSample } from './plugin-syntax-samples'

// First extension each official syntax plugin lists in orca-catalog.json.
const OFFICIAL_SYNTAX_EXTENSIONS = [
  '.gleam',
  '.prisma',
  '.nix',
  '.gd',
  '.tex',
  '.vhd',
  '.vcl',
  '.qml',
  '.tks',
  '.http',
  '.service',
  '.m',
  '.ml',
  '.jl',
  '.hs',
  '.erl',
  '.jsp'
]

describe('pluginSyntaxSample', () => {
  it.each(OFFICIAL_SYNTAX_EXTENSIONS)('has a non-trivial sample for %s', (extension) => {
    const sample = pluginSyntaxSample([{ extensions: [extension] }])
    expect(sample?.extension).toBe(extension)
    expect(sample?.content.split('\n').length).toBeGreaterThanOrEqual(6)
    expect(sample?.content.endsWith('\n')).toBe(true)
  })

  it('uses the first listed extension that has a sample, keeping its case', () => {
    expect(
      pluginSyntaxSample([{ extensions: ['.vho'] }, { extensions: ['.VHD', '.vcl'] }])
    ).toMatchObject({ extension: '.VHD' })
  })

  it('returns null when no extension has a sample', () => {
    expect(pluginSyntaxSample([{ extensions: ['.unknown'] }, { extensions: [] }])).toBeNull()
  })

  it('keeps escaped characters that template literals would otherwise drop', () => {
    expect(pluginSyntaxSample([{ extensions: ['.vcl'] }])?.content).toContain('"\\.(css')
    expect(pluginSyntaxSample([{ extensions: ['.hs'] }])?.content).toContain('(\\w -> (w, 1))')
  })
})
