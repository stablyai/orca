import { describe, expect, it } from 'vitest'
import { readRuntimeSourceStamp, stampRuntimeSourceEnv } from './runtime-source-env'

describe('runtime source env', () => {
  it('round-trips a stamp and replaces an inherited one', () => {
    const env: Record<string, string | undefined> = {
      ORCA_RUNTIME_SOURCE_ID: 'parent',
      ORCA_RUNTIME_SOURCE_INCARNATION: 'parent-runtime'
    }
    stampRuntimeSourceEnv(env, { sourceId: 'child', incarnation: 'child-runtime' })
    expect(readRuntimeSourceStamp(env)).toEqual({ sourceId: 'child', incarnation: 'child-runtime' })
  })

  it('clears an inherited stamp when this runtime has none', () => {
    const env: Record<string, string | undefined> = {
      ORCA_RUNTIME_SOURCE_ID: 'parent',
      ORCA_RUNTIME_SOURCE_INCARNATION: 'parent-runtime'
    }
    stampRuntimeSourceEnv(env, null)
    expect(env).toEqual({})
  })

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
