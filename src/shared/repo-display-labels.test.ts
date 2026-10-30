import { describe, expect, it, vi } from 'vitest'
import { getRepoDisplayLabelKey, getRepoDisplayLabelsByPath } from './repo-display-labels'

describe('getRepoDisplayLabelsByPath', () => {
  it('adds the minimal real parent suffix only for colliding basenames', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/platform/web', displayName: 'web' },
      { path: '/workspace/platform/payments/api', displayName: 'api' },
      { path: '/workspace/platform/billing/api', displayName: 'api' }
    ])

    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/web' }))).toBe('web')
    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/payments/api' }))).toBe(
      'payments/api'
    )
    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/platform/billing/api' }))).toBe(
      'billing/api'
    )
  })

  it('expands colliding labels in lockstep without skipping shared segments', () => {
    const labels = getRepoDisplayLabelsByPath([
      { path: '/workspace/team1/shared/api', displayName: 'api' },
      { path: '/workspace/team2/shared/api', displayName: 'api' }
    ])

    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/team1/shared/api' }))).toBe(
      'team1/shared/api'
    )
    expect(labels.get(getRepoDisplayLabelKey({ path: '/workspace/team2/shared/api' }))).toBe(
      'team2/shared/api'
    )
  })

  it('keeps cross-host repos with identical path AND name as separate entries', () => {
    const localRepo = { path: '/Users/alice', displayName: 'home' }
    const sshRepo = { path: '/Users/alice', displayName: 'home', connectionId: 'prod-ssh' }
    const labels = getRepoDisplayLabelsByPath([localRepo, sshRepo])

    expect(getRepoDisplayLabelKey(localRepo)).not.toBe(getRepoDisplayLabelKey(sshRepo))
    expect(labels.size).toBe(2)
    expect(labels.get(getRepoDisplayLabelKey(localRepo))).toBe('home')
    expect(labels.get(getRepoDisplayLabelKey(sshRepo))).toBe('home')
  })

  it('disambiguates collisions only within their owning host, even when paths overlap', () => {
    const local = { path: '/workspace/payments/api', displayName: 'api' }
    const sibling = { path: '/workspace/billing/api', displayName: 'api' }
    const paired = { ...local, executionHostId: 'runtime:home' as const }
    const labels = getRepoDisplayLabelsByPath([local, sibling, paired])
    expect(labels.get(getRepoDisplayLabelKey(local))).toBe('payments/api')
    expect(labels.get(getRepoDisplayLabelKey(sibling))).toBe('billing/api')
    expect(labels.get(getRepoDisplayLabelKey(paired))).toBe('api')
    expect(labels.size).toBe(3)
  })

  it('does not add path segments for matching names at different paths on different SSH hosts', () => {
    const first = { path: '/work/payments/api', displayName: 'api', connectionId: 'first' }
    const second = { path: '/work/billing/api', displayName: 'api', connectionId: 'second' }
    const labels = getRepoDisplayLabelsByPath([first, second])
    expect(labels.get(getRepoDisplayLabelKey(first))).toBe('api')
    expect(labels.get(getRepoDisplayLabelKey(second))).toBe('api')
  })

  it('resolves explicit execution ownership before legacy connection metadata', () => {
    const first = {
      path: '/work/payments/api',
      displayName: 'api',
      connectionId: 'old',
      executionHostId: 'runtime:first' as const
    }
    const second = {
      path: '/work/billing/api',
      displayName: 'api',
      connectionId: 'old',
      executionHostId: 'runtime:second' as const
    }
    const labels = getRepoDisplayLabelsByPath([first, second])
    expect(labels.get(getRepoDisplayLabelKey(first))).toBe('api')
    expect(labels.get(getRepoDisplayLabelKey(second))).toBe('api')
  })

  it('keeps Windows labels separate across hosts that share a path', () => {
    const first = { path: 'C:\\work\\payments\\api', displayName: 'api' }
    const sibling = { path: 'C:\\work\\billing\\api', displayName: 'api' }
    const paired = { ...first, executionHostId: 'runtime:windows' as const }
    const labels = getRepoDisplayLabelsByPath([first, sibling, paired])
    expect(labels.get(getRepoDisplayLabelKey(first))).toBe('payments/api')
    expect(labels.get(getRepoDisplayLabelKey(sibling))).toBe('billing/api')
    expect(labels.get(getRepoDisplayLabelKey(paired))).toBe('api')
  })

  it('preserves suffix disambiguation for local WSL distro paths', () => {
    const first = { path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\app', displayName: 'app' }
    const second = { path: '\\\\wsl.localhost\\Debian\\home\\user\\app', displayName: 'app' }
    const labels = getRepoDisplayLabelsByPath([first, second])
    expect(labels.get(getRepoDisplayLabelKey(first))).toBe('Ubuntu/home/user/app')
    expect(labels.get(getRepoDisplayLabelKey(second))).toBe('Debian/home/user/app')
  })
})

it.each(['/work', 'C:\\work', '//server/share'])(
  'retains the real differing leaf for same-name siblings at %s',
  (root) => {
    const entries = ['harbor-first', 'harbor-second'].map((leaf) => ({
      path: `${root}/${leaf}`,
      displayName: 'Harbor'
    }))
    const labels = getRepoDisplayLabelsByPath(entries)
    expect(entries.map((entry) => labels.get(getRepoDisplayLabelKey(entry)))).toEqual([
      'harbor-first',
      'harbor-second'
    ])
  }
)

it.each(['items', 'depth'] as const)(
  'normalizes each actual label input once and bounds suffix work with independent %s N/10N',
  (dimension) => {
    for (const n of [100, 1000]) {
      const count = dimension === 'items' ? n : 2
      const depth = dimension === 'depth' ? n : 4
      const entries = Array.from({ length: count }, (_, i) => ({
        path: `/${i}/${Array(depth - 2)
          .fill('shared')
          .join('/')}/leaf`,
        displayName: 'Harbor'
      }))
      const replace = String.prototype.replace
      const join = Array.prototype.join
      let normalizations = 0
      let suffixes = 0
      let characters = 0
      const replaceProbe = vi.spyOn(String.prototype, 'replace').mockImplementation(function (
        this: string,
        pattern,
        replacement
      ) {
        if (pattern instanceof RegExp && pattern.source === '\\\\') {
          normalizations++
        }
        return replace.call(this, pattern, replacement)
      })
      const joinProbe = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
        this: string[],
        separator?: string
      ) {
        const value = join.call(this, separator)
        if (separator === '/') {
          suffixes++
          characters += value.length
        }
        return value
      })
      try {
        const labels = getRepoDisplayLabelsByPath(entries)
        expect(new Set(labels.values()).size).toBe(count)
        expect([...labels.values()][0]).toBe(
          `0/${Array(depth - 2)
            .fill('shared')
            .join('/')}/Harbor`
        )
        expect(normalizations).toBe(count)
        expect(suffixes).toBeGreaterThanOrEqual(count * depth)
        expect(suffixes).toBeLessThanOrEqual(count * depth + 1)
        expect(characters).toBeLessThanOrEqual(count * depth * depth * 10)
        process.stdout.write(
          `PG8 labels operations ${JSON.stringify({ dimension, n, count, depth, normalizations, suffixes, characters })}\n`
        )
      } finally {
        replaceProbe.mockRestore()
        joinProbe.mockRestore()
      }
    }
  }
)
