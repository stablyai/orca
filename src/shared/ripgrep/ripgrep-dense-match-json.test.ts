import { expect, it } from 'vitest'
import { parseDenseRipgrepMatchJson } from './ripgrep-dense-match-json'

it('validates submatches after reaching the requested result cap', () => {
  const source = JSON.stringify({
    type: 'match',
    data: {
      submatches: [
        { start: 0, end: 1 },
        { start: null, end: 2 }
      ]
    }
  })
  expect(() => parseDenseRipgrepMatchJson(source, 1, 16)).toThrow('Invalid rg submatch')
})

it('rejects duplicate coordinate fields whose final value is not numeric', () => {
  const source = '{"data":{"submatches":[{"start":0,"start":{},"end":1}]}}'
  expect(() => parseDenseRipgrepMatchJson(source, 1, 16)).toThrow('Invalid rg submatch')
})
