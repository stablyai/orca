import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY
} from './protocol-version'
import {
  RUNTIME_CAPABILITY_DOCS,
  describeRuntimeCapabilities,
  listUndocumentedRuntimeCapabilities
} from './runtime-capability-docs'

describe('runtime capability docs', () => {
  it('documents every static RUNTIME_CAPABILITIES entry', () => {
    expect(listUndocumentedRuntimeCapabilities()).toEqual([])
    for (const name of RUNTIME_CAPABILITIES) {
      expect(RUNTIME_CAPABILITY_DOCS[name]?.length).toBeGreaterThan(10)
    }
  })

  it('documents conditional browser capabilities used by getStatus', () => {
    expect(RUNTIME_CAPABILITY_DOCS[BROWSER_HEADLESS_RUNTIME_CAPABILITY]).toBeTruthy()
    expect(RUNTIME_CAPABILITY_DOCS[BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY]).toBeTruthy()
  })

  it('projects only advertised flags into capabilityDocs', () => {
    expect(
      describeRuntimeCapabilities([
        'aiVault.v1',
        'not-a-real-capability.v9',
        BROWSER_HEADLESS_RUNTIME_CAPABILITY
      ])
    ).toEqual({
      'aiVault.v1': RUNTIME_CAPABILITY_DOCS['aiVault.v1'],
      [BROWSER_HEADLESS_RUNTIME_CAPABILITY]:
        RUNTIME_CAPABILITY_DOCS[BROWSER_HEADLESS_RUNTIME_CAPABILITY]
    })
  })
})
