import { describe, expect, it } from 'vitest'
import { pluginSourceMapPrelude } from '../../frames/plugin-frame-source-map-prelude'
import { describePluginError, describePluginErrorForLog } from './declarative-error-location'
import {
  decodeSourceMapMappings,
  originalPluginPosition,
  registerPluginSourceMap
} from './declarative-source-maps'

const base = 'orca-plugin-frame://0123456789abcdef/'

describe('plugin source maps in the guest', () => {
  it('decodes VLQ mappings per generated line, carrying source deltas across lines', () => {
    expect(decodeSourceMapMappings('AAAA;AACA,IAAI;;AADD')).toEqual([
      [[0, 0, 0]],
      [
        [0, 1, 0],
        [4, 1, 4]
      ],
      [],
      [[0, 0, 3]]
    ])
  })

  it('maps a generated position to its segment, shifting line 1 past the prelude', () => {
    const url = `${base}src/a.tsx?rev=1`
    registerPluginSourceMap(url, 'AAAA,IAAI;AACA,IAAU')
    // Line 2: generated column 5 (0-based 4) is the segment at source column 14 (4 carried + 10).
    expect(originalPluginPosition(url, 2, 5)).toEqual({ line: 2, column: 15 })
    expect(originalPluginPosition(url, 2, 9)).toEqual({ line: 2, column: 15 })
    const shift = pluginSourceMapPrelude('AAAA,IAAI;AACA,IAAU').length
    expect(originalPluginPosition(url, 1, shift + 5)).toEqual({ line: 1, column: 5 })
    expect(originalPluginPosition(`${base}src/unmapped.ts`, 2, 5)).toBeNull()
  })
})

describe('plugin errors as logged', () => {
  it('locates the message and stack frames at source positions, without Orca runtime frames', () => {
    const url = `${base}src/panel.tsx?rev=2`
    registerPluginSourceMap(url, ';;AAEA,IAAM')
    const error = Object.assign(new Error('boom'), {
      stack: [
        'Error: boom',
        `    at Panel (${url}:3:5)`,
        `    at evaluate (${base}__orca/orca-runtime.mjs:120:7)`,
        `    at helper (${base}src/util.ts:7:2)`,
        '    at Array.map (<anonymous>)'
      ].join('\n')
    })
    expect(describePluginError(error, base)).toBe('src/panel.tsx:3:7: boom')
    expect(describePluginErrorForLog(error, base)).toBe(
      [
        'src/panel.tsx:3:7: boom',
        '    at Panel (src/panel.tsx:3:7)',
        '    at helper (src/util.ts:7:2)',
        '    at Array.map (<anonymous>)'
      ].join('\n')
    )
  })

  it('logs a transpile error module by its own location, not where its throw sits', () => {
    const error = Object.assign(new Error('src/panel.tsx:48:7: Unexpected token'), {
      stack: `Error: src/panel.tsx:48:7: Unexpected token\n    at ${base}src/panel.tsx?rev=3:1:7`
    })
    expect(describePluginErrorForLog(error, base)).toBe('src/panel.tsx:48:7: Unexpected token')
    // An import refusal in another module is located the same way.
    const refused = Object.assign(new Error('src/lib/a.ts:2:19: cannot import "react"'), {
      stack: `Error: x\n    at ${base}src/lib/a.ts:1:7`
    })
    expect(describePluginError(refused, base)).toBe('src/lib/a.ts:2:19: cannot import "react"')
  })

  it('logs the plain stack outside a guest', () => {
    const error = Object.assign(new Error('boom'), { stack: 'Error: boom\n    at x (/a.js:1:1)' })
    expect(describePluginErrorForLog(error, null)).toBe('Error: boom\n    at x (/a.js:1:1)')
    expect(describePluginErrorForLog('thrown', base)).toBe('thrown')
  })
})
