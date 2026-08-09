import { describe, expect, it } from 'vitest'
import { resolveHydrationPtyOwnership } from './terminal-hydration-pty-ownership'

const row = (
  tabId: string,
  ptyIds: string[],
  overrides: {
    isCanonical?: boolean
    sortOrder?: number
    createdAt?: number
  } = {}
) => ({
  tabId,
  isCanonical: overrides.isCanonical ?? false,
  sortOrder: overrides.sortOrder ?? 0,
  createdAt: overrides.createdAt ?? 0,
  ptyIds
})

describe('resolveHydrationPtyOwnership', () => {
  it('gives the canonical row ownership of a PTY a stale row also claims', () => {
    const ownership = resolveHydrationPtyOwnership([
      row('stale', ['pty-1'], { sortOrder: 0 }),
      row('canonical', ['pty-1'], { isCanonical: true, sortOrder: 9 })
    ])

    expect(ownership.ownsPtyId('canonical', 'pty-1')).toBe(true)
    expect(ownership.ownsPtyId('stale', 'pty-1')).toBe(false)
    expect(ownership.ownsAnyPtyId('stale')).toBe(false)
  })

  it('keeps every row that owns a distinct PTY', () => {
    const ownership = resolveHydrationPtyOwnership([
      row('canonical', ['pty-1'], { isCanonical: true }),
      row('legacy', ['pty-2'])
    ])

    expect(ownership.ownsPtyId('legacy', 'pty-2')).toBe(true)
    expect(ownership.ownsAnyPtyId('legacy')).toBe(true)
  })

  it('splits ownership per PTY so a partial overlap keeps the unshared leaf', () => {
    const ownership = resolveHydrationPtyOwnership([
      row('canonical', ['shared'], { isCanonical: true }),
      row('legacy', ['shared', 'own'])
    ])

    expect(ownership.ownsPtyId('legacy', 'shared')).toBe(false)
    expect(ownership.ownsPtyId('legacy', 'own')).toBe(true)
    expect(ownership.ownsAnyPtyId('legacy')).toBe(true)
  })

  it('falls back to sort order then createdAt when no row is canonical', () => {
    const ownership = resolveHydrationPtyOwnership([
      row('later', ['pty-1'], { sortOrder: 1 }),
      row('earlier', ['pty-1'], { sortOrder: 0 })
    ])

    expect(ownership.ownsPtyId('earlier', 'pty-1')).toBe(true)
    expect(ownership.ownsPtyId('later', 'pty-1')).toBe(false)
  })

  it('resolves ties deterministically regardless of input order', () => {
    const forward = resolveHydrationPtyOwnership([row('b', ['pty-1']), row('a', ['pty-1'])])
    const reverse = resolveHydrationPtyOwnership([row('a', ['pty-1']), row('b', ['pty-1'])])

    expect(forward.ownsPtyId('a', 'pty-1')).toBe(true)
    expect(reverse.ownsPtyId('a', 'pty-1')).toBe(true)
  })
})
