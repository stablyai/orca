import { describe, expect, it } from 'vitest'
import { classifyJsonRpcPrefix } from './json-rpc-record-prefix'

describe('classifyJsonRpcPrefix', () => {
  it('reads complete numeric ids, including exponents and trailing whitespace', () => {
    expect(classifyJsonRpcPrefix('{"result":null,"id":1e3}')).toEqual({
      kind: 'response',
      id: 1000
    })
    expect(classifyJsonRpcPrefix('{"result":null,"id":12\n,')).toEqual({
      kind: 'response',
      id: 12
    })
    expect(classifyJsonRpcPrefix('{"id":1,"result":12')).toEqual({ kind: 'response', id: 1 })
  })

  it('never attributes a record to a numeric id that is cut off or malformed', () => {
    for (const prefix of [
      '{"result":null,"id":12',
      '{"result":null,"id":1e',
      '{"result":null,"id":1.',
      '{"result":null,"id":-',
      '{"result":null,"id":',
      '{"id":12x}',
      '{"method":"x","params":{},"id":12'
    ]) {
      expect(classifyJsonRpcPrefix(prefix)).toEqual({ kind: 'response-unknown' })
    }
  })

  it('ignores ids that are not numbers, even when cut off', () => {
    for (const prefix of [
      '{"error":null,"id":null}',
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32700',
      '{"jsonrpc":"2.0","id":"perm-1',
      '{"result":null,"id":nu'
    ]) {
      expect(classifyJsonRpcPrefix(prefix)).toEqual({ kind: 'unknown' })
    }
    expect(classifyJsonRpcPrefix('{"id":null,"method":"_x","params":{')).toEqual({
      kind: 'notification',
      method: '_x'
    })
  })
})
