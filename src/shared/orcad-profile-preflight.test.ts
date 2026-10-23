import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ORCAD_NODE_RUNTIME_IDENTITY } from './orcad-node-runtime-identity'
import {
  parseOrcadProfilePreflight,
  type OrcadPreflightRuntimeIdentity
} from './orcad-profile-preflight'

const response = {
  type: 'orca_profile_state_ready',
  nonce: randomUUID(),
  runtime: 'bun',
  runtimeVersion: '1.4.2',
  artifactVersion: '0.1.0+123456789abc',
  sqliteVersion: '3.51.0',
  revision: 1
}

const bun: OrcadPreflightRuntimeIdentity = { runtime: 'bun', runtimeVersion: '1.4.2' }

function parse(value: unknown, expected = bun) {
  return parseOrcadProfilePreflight(
    JSON.stringify(value),
    response.nonce,
    expected,
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

  it('admits a Node candidate only when the caller launched Node', () => {
    const node = { ...response, runtime: 'node', runtimeVersion: '24.21.0' }
    const expected: OrcadPreflightRuntimeIdentity = { runtime: 'node', runtimeVersion: '24.21.0' }
    expect(parse(node, expected)).toEqual(node)
    expect(() => parse(node)).toThrow('expected candidate runtime')
    expect(() => parse(response, expected)).toThrow('expected candidate runtime')
  })

  it('shipped callers require the pinned Node, not a Bun slot or a host Node', () => {
    expect(ORCAD_NODE_RUNTIME_IDENTITY.runtime).toBe('node')
    expect(() => parse(response, ORCAD_NODE_RUNTIME_IDENTITY)).toThrow()
    expect(() =>
      parse({ ...response, runtime: 'node', runtimeVersion: '18.0.0' }, ORCAD_NODE_RUNTIME_IDENTITY)
    ).toThrow('expected candidate runtime')
  })

  it('does not choose a successful line out of contradictory output', () => {
    expect(() =>
      parseOrcadProfilePreflight(
        `${JSON.stringify(response)}\n${JSON.stringify({ ...response, revision: 0 })}`,
        response.nonce,
        bun
      )
    ).toThrow()
  })
})
