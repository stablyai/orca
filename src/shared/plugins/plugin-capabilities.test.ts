import { describe, expect, it } from 'vitest'
import { canonicalizeCapabilitySet, type PluginCapabilityKind } from './plugin-capabilities'
import { fingerprintPluginConsent } from './plugin-consent-fingerprint'
import { parsePluginManifest, type PluginManifest } from './plugin-manifest'

// Spelled out locally on purpose: a later phase widens the exported kind list, and a
// test that read that list would silently start pinning a different subject.
const PRE_EXISTING_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage',
  'secrets',
  'events:subscribe',
  'settings:own'
] as const satisfies readonly PluginCapabilityKind[]

const PRE_EXISTING_CANONICAL_ENCODING =
  '["{\\"kind\\":\\"events:subscribe\\"}","{\\"kind\\":\\"notifications:show\\"}","{\\"kind\\":\\"secrets\\"}","{\\"kind\\":\\"settings:own\\"}","{\\"kind\\":\\"storage\\"}","{\\"kind\\":\\"terminal:send\\"}","{\\"kind\\":\\"workspace:read\\"}"]'

// Typed from the local seven, not from the exported kind list: that constant now
// carries nine kinds, one of which is scoped and cannot be built from a bare kind.
const PER_KIND_ENCODINGS: [(typeof PRE_EXISTING_KINDS)[number], string][] = [
  ['workspace:read', '["{\\"kind\\":\\"workspace:read\\"}"]'],
  ['terminal:send', '["{\\"kind\\":\\"terminal:send\\"}"]'],
  ['notifications:show', '["{\\"kind\\":\\"notifications:show\\"}"]'],
  ['storage', '["{\\"kind\\":\\"storage\\"}"]'],
  ['secrets', '["{\\"kind\\":\\"secrets\\"}"]'],
  ['events:subscribe', '["{\\"kind\\":\\"events:subscribe\\"}"]'],
  ['settings:own', '["{\\"kind\\":\\"settings:own\\"}"]']
]

describe('canonicalizeCapabilitySet', () => {
  it('pins the canonical encoding of every pre-existing capability kind', () => {
    // Why: this exact string is hashed into the stored consent fingerprint, so ANY
    // drift silently drops every installed plugin to pending re-approval with no
    // error raised. Recompute only for a deliberate, migration-accompanied change.
    const encoded = canonicalizeCapabilitySet(PRE_EXISTING_KINDS.map((kind) => ({ kind })))

    expect(encoded).toHaveLength(214)
    expect(encoded).toBe(PRE_EXISTING_CANONICAL_ENCODING)
  })

  it.each(PER_KIND_ENCODINGS)('pins the single-entry encoding of %s', (kind, expected) => {
    expect(canonicalizeCapabilitySet([{ kind }])).toBe(expected)
  })

  it('pins the empty capability set to the two-character empty JSON array', () => {
    expect(canonicalizeCapabilitySet([])).toBe('[]')
  })
})

function manifest(capabilities: unknown): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { panels: [], commands: [], events: [] },
    capabilities
  }
}

function parsedManifest(capabilities: unknown): PluginManifest {
  const result = parsePluginManifest(manifest(capabilities))
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.manifest
}

// Written out again rather than reused from the pin above: this assertion has to
// fail on its own evidence if the parsed shape of an unscoped kind ever moves.
const PARSED_PRE_EXISTING_ENCODING =
  '["{\\"kind\\":\\"events:subscribe\\"}","{\\"kind\\":\\"notifications:show\\"}","{\\"kind\\":\\"secrets\\"}","{\\"kind\\":\\"settings:own\\"}","{\\"kind\\":\\"storage\\"}","{\\"kind\\":\\"terminal:send\\"}","{\\"kind\\":\\"workspace:read\\"}"]'

describe('scoped capabilities through the manifest schema', () => {
  it('leaves the pre-existing kinds byte-identical after parsing through the union', () => {
    // Why: the whole phase's compatibility risk in one line. It goes red the instant a
    // parsed unscoped capability grows a second key, which is the change that would drop
    // every installed plugin to pending re-approval.
    const encoded = canonicalizeCapabilitySet(
      parsedManifest(PRE_EXISTING_KINDS.map((kind) => ({ kind }))).capabilities
    )

    expect(encoded).toHaveLength(214)
    expect(encoded).toBe(PARSED_PRE_EXISTING_ENCODING)
  })

  it('accepts a files:read capability declaring a glob', () => {
    expect(
      parsePluginManifest(manifest([{ kind: 'files:read', paths: ['.planning/**'] }])).ok
    ).toBe(true)
  })

  it('accepts the unscoped workspace:list capability', () => {
    expect(parsePluginManifest(manifest([{ kind: 'workspace:list' }])).ok).toBe(true)
  })

  it('binds the declared globs into the consent fingerprint', () => {
    const narrow = fingerprintPluginConsent(
      parsedManifest([{ kind: 'files:read', paths: ['.planning/**'] }])
    )
    const wider = fingerprintPluginConsent(
      parsedManifest([{ kind: 'files:read', paths: ['.planning/**', '*.md'] }])
    )

    expect(narrow).not.toBe(wider)
  })

  it('is insensitive to declaration order and duplicate globs', () => {
    const asDeclared = parsedManifest([
      { kind: 'files:read', paths: ['.planning/**', '*.md', '.planning/**'] }
    ])
    const canonical = parsedManifest([{ kind: 'files:read', paths: ['*.md', '.planning/**'] }])

    expect(asDeclared.capabilities[0]).toEqual({
      kind: 'files:read',
      paths: ['*.md', '.planning/**']
    })
    expect(fingerprintPluginConsent(asDeclared)).toBe(fingerprintPluginConsent(canonical))
  })
})
