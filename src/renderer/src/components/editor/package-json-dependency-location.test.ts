import { describe, expect, it } from 'vitest'
import { locatePackageJsonDependencyAtOffset } from './package-json-dependency-location'

function offsetOfKey(text: string, key: string, occurrence = 0): number {
  const needle = `"${key}"`
  let index = -1
  for (let count = 0; count <= occurrence; count += 1) {
    index = text.indexOf(needle, index + 1)
  }
  // one char into the key, inside the quotes
  return index + 2
}

describe('locatePackageJsonDependencyAtOffset', () => {
  it.each([
    ['dependencies', 'react'],
    ['devDependencies', 'vitest'],
    ['peerDependencies', 'react-dom'],
    ['optionalDependencies', 'fsevents'],
    ['catalog', 'lodash']
  ] as const)('resolves a key hovered under %s', (section, packageName) => {
    const text = `{\n  "${section}": {\n    "${packageName}": "1.0.0"\n  }\n}\n`
    const offset = offsetOfKey(text, packageName)

    const result = locatePackageJsonDependencyAtOffset(text, offset)

    expect(result).toEqual({
      packageName,
      section,
      startOffset: text.indexOf(`"${packageName}"`),
      endOffset: text.indexOf(`"${packageName}"`) + packageName.length + 2
    })
  })

  it('returns null for a nested object that coincidentally shares a section name', () => {
    const text = '{\n  "config": { "dependencies": { "react": "1.0.0" } }\n}\n'
    const offset = offsetOfKey(text, 'react')

    expect(locatePackageJsonDependencyAtOffset(text, offset)).toBeNull()
  })

  it('returns null for overrides and resolutions', () => {
    const text =
      '{\n  "overrides": { "react": "1.0.0" },\n  "resolutions": { "react": "1.0.0" }\n}\n'

    expect(locatePackageJsonDependencyAtOffset(text, offsetOfKey(text, 'react', 0))).toBeNull()
    expect(locatePackageJsonDependencyAtOffset(text, offsetOfKey(text, 'react', 1))).toBeNull()
  })

  it('returns null when hovering the value instead of the key', () => {
    const text = '{\n  "dependencies": { "react": "1.0.0" }\n}\n'
    const offset = text.indexOf('1.0.0')

    expect(locatePackageJsonDependencyAtOffset(text, offset)).toBeNull()
  })

  it('returns null when hovering whitespace between the key and the colon', () => {
    const text = '{\n  "dependencies": { "react"   : "1.0.0" }\n}\n'
    const offset = text.indexOf('react"') + 8

    expect(locatePackageJsonDependencyAtOffset(text, offset)).toBeNull()
  })
})
