import { describe, expect, it } from 'vitest'
import { isSameAutomationOwner, parseHostStableKey } from './automation-owner-key'
import type { AutomationOwnerRef } from './automation-owner-ref'

const runtimeSsh = (
  environmentId: string,
  pairingRevision: number,
  targetId: string,
  targetGeneration: number
): AutomationOwnerRef => ({
  authority: { kind: 'runtime', environmentId, pairingRevision },
  selector: { kind: 'ssh', targetId, targetGeneration }
})

describe('incarnation sensitivity', () => {
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
})

describe('parseHostStableKey', () => {
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
