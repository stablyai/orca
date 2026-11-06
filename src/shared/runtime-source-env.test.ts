import { describe, expect, it } from 'vitest'
import { readRuntimeSourceStamp } from './runtime-source-env'

describe('runtime source env', () => {
  it('treats a partial or oversized stamp as no stamp', () => {
    expect(readRuntimeSourceStamp({ ORCA_RUNTIME_SOURCE_ID: 'only-id' })).toBeNull()
    expect(
      readRuntimeSourceStamp({
        ORCA_RUNTIME_SOURCE_ID: 'x'.repeat(4_097),
        ORCA_RUNTIME_SOURCE_INCARNATION: 'runtime'
      })
    ).toBeNull()
  })
})
