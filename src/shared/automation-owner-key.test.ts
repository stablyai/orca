import { describe, expect, it } from 'vitest'
import {
  hostStableKey,
  isSameAutomationOwner,
  isSameStableAutomationHost,
  ownerKey,
  parseHostStableKey,
  toStableCatalogRef
} from './automation-owner-key'
import type { AutomationOwnerRef, StableAutomationCatalogRef } from './automation-owner-ref'

const desktopSelf: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}

const desktopSsh = (targetId: string, targetGeneration: number): AutomationOwnerRef => ({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId, targetGeneration }
})

const runtimeSsh = (
  environmentId: string,
  pairingRevision: number,
  targetId: string,
  targetGeneration: number
): AutomationOwnerRef => ({
  authority: { kind: 'runtime', environmentId, pairingRevision },
  selector: { kind: 'ssh', targetId, targetGeneration }
})

describe('automation owner key injectivity', () => {
  it('does not let a separator inside a component forge another key', () => {
    // Naive concatenation collides here: both produce host:runtime:a:ssh:self.
    const environmentIdCarriesSelector: StableAutomationCatalogRef = {
      authority: { kind: 'runtime', environmentId: 'a:ssh' },
      selector: { kind: 'self' }
    }
    const targetIdCarriesSelector: StableAutomationCatalogRef = {
      authority: { kind: 'runtime', environmentId: 'a' },
      selector: { kind: 'ssh', targetId: 'self' }
    }
    expect(hostStableKey(environmentIdCarriesSelector)).not.toBe(
      hostStableKey(targetIdCarriesSelector)
    )
  })

  it('does not let a pre-escaped component alias an unescaped one', () => {
    expect(
      hostStableKey({
        authority: { kind: 'desktop' },
        selector: { kind: 'ssh', targetId: 'a%3Ab' }
      })
    ).not.toBe(
      hostStableKey({ authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 'a:b' } })
    )
  })

  it('separates desktop from runtime for the same selector', () => {
    expect(ownerKey(desktopSelf)).not.toBe(
      ownerKey({
        authority: { kind: 'runtime', environmentId: 'e1', pairingRevision: 1 },
        selector: { kind: 'self' }
      })
    )
  })

  it('separates the same target id under desktop and under a runtime', () => {
    expect(ownerKey(desktopSsh('t1', 4))).not.toBe(ownerKey(runtimeSsh('e1', 1, 't1', 4)))
  })

  it('keeps stable and owner keys in separate namespaces', () => {
    expect(ownerKey(desktopSelf)).not.toBe(hostStableKey(toStableCatalogRef(desktopSelf)))
  })
})

describe('incarnation sensitivity', () => {
  it('stable key ignores pairing revision and target generation', () => {
    expect(hostStableKey(toStableCatalogRef(runtimeSsh('e1', 1, 't1', 4)))).toBe(
      hostStableKey(toStableCatalogRef(runtimeSsh('e1', 9, 't1', 7)))
    )
    expect(
      isSameStableAutomationHost(
        toStableCatalogRef(runtimeSsh('e1', 1, 't1', 4)),
        toStableCatalogRef(runtimeSsh('e1', 9, 't1', 7))
      )
    ).toBe(true)
  })

  it('owner key does not ignore them', () => {
    expect(isSameAutomationOwner(runtimeSsh('e1', 1, 't1', 4), runtimeSsh('e1', 1, 't1', 4))).toBe(
      true
    )
    expect(isSameAutomationOwner(runtimeSsh('e1', 1, 't1', 4), runtimeSsh('e1', 1, 't1', 5))).toBe(
      false
    )
    expect(isSameAutomationOwner(runtimeSsh('e1', 1, 't1', 4), runtimeSsh('e1', 2, 't1', 4))).toBe(
      false
    )
  })

  it('drops incarnations when projecting an owner to a stable ref', () => {
    expect(toStableCatalogRef(runtimeSsh('e1', 3, 't1', 4))).toEqual({
      authority: { kind: 'runtime', environmentId: 'e1' },
      selector: { kind: 'ssh', targetId: 't1' }
    })
  })
})

describe('parseHostStableKey', () => {
  const refs: StableAutomationCatalogRef[] = [
    { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    { authority: { kind: 'desktop' }, selector: { kind: 'orphan' } },
    { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 'weird:id/with spaces' } },
    { authority: { kind: 'runtime', environmentId: 'env:1' }, selector: { kind: 'self' } },
    { authority: { kind: 'runtime', environmentId: 'env 1' }, selector: { kind: 'orphan' } },
    { authority: { kind: 'runtime', environmentId: 'e' }, selector: { kind: 'ssh', targetId: 't' } }
  ]

  it('round-trips every catalog ref shape', () => {
    for (const ref of refs) {
      expect(parseHostStableKey(hostStableKey(ref))).toEqual(ref)
    }
  })

  it.each([
    '',
    'host',
    'owner:desktop:self',
    'host:desktop',
    'host:desktop:ssh',
    'host:desktop:ssh:a:b',
    'host:desktop:bogus',
    'host:runtime:self',
    'host:runtime::self',
    // non-canonical escaping must not alias the canonical key
    'host:desktop:ssh:a/b'
  ])('rejects malformed key %s', (key) => {
    expect(parseHostStableKey(key)).toBeNull()
  })
})
