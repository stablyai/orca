import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseOrcadProfilePreflight } from './orcad-profile-preflight'

const response = {
  type: 'orca_profile_state_ready',
  nonce: randomUUID(),
  runtime: 'bun',
  runtimeVersion: '1.4.2',
  artifactVersion: '0.1.0+123456789abc',
  sqliteVersion: '3.51.0',
  revision: 1
}

function parse(value: unknown) {
  return parseOrcadProfilePreflight(
    JSON.stringify(value),
    response.nonce,
    response.runtimeVersion,
    response.artifactVersion
  )
}

describe('candidate profile readiness', () => {
  it('admits an acknowledged write and backup under the expected installed runtime', () => {
    expect(parse(response)).toEqual(response)
  })

  it.each([
    { nonce: randomUUID() },
    { runtime: 'node' },
    { runtimeVersion: '1.4.0' },
    { artifactVersion: '0.1.0+000000000000' },
    { revision: 0 },
    { sqliteVersion: '' }
  ])('refuses stale or incomplete evidence: %j', (change) => {
    expect(() => parse({ ...response, ...change })).toThrow()
  })

  it('does not choose a successful line out of contradictory output', () => {
    expect(() =>
      parseOrcadProfilePreflight(
        `${JSON.stringify(response)}\n${JSON.stringify({ ...response, revision: 0 })}`,
        response.nonce,
        response.runtimeVersion
      )
    ).toThrow()
  })
})
