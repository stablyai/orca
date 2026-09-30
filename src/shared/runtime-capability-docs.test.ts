import { describe, expect, it } from 'vitest'
import {
  BROWSER_HEADLESS_RUNTIME_CAPABILITY,
  BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY
} from './protocol-version'
import {
  RUNTIME_CAPABILITY_DOCS,
  describeRuntimeCapabilities,
  listUndocumentedRuntimeCapabilities
} from './runtime-capability-docs'

describe('runtime capability docs', () => {
  it('documents known runtime capability entries with descriptive text', () => {
    expect(Object.keys(RUNTIME_CAPABILITY_DOCS).length).toBeGreaterThan(20)
    for (const [, doc] of Object.entries(RUNTIME_CAPABILITY_DOCS)) {
      expect(doc.length).toBeGreaterThan(10)
    }
  })

  it('lists capabilities that lack documentation entries', () => {
    const undocumented = listUndocumentedRuntimeCapabilities()
    expect(Array.isArray(undocumented)).toBe(true)
    for (const name of undocumented) {
      expect(RUNTIME_CAPABILITY_DOCS[name]).toBeUndefined()
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
