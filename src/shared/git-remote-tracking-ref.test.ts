import { expect, it, vi } from 'vitest'
import { readGitRemoteTrackingRef } from './git-remote-tracking-ref'

it.each([
  ['+refs/heads/*:refs/custom/*', 'feature-$&', 'refs/custom/feature-$&'],
  ['+refs/heads/*:refs/custom/origin/*', 'feature', 'refs/custom/origin/feature'],
  [
    '+refs/heads/feature*:refs/heads/tracking/feature*',
    'feature/nested',
    'refs/heads/tracking/feature/nested'
  ],
  ['refs/heads/feature:refs/tracked-feature', 'feature', 'refs/tracked-feature'],
  [
    'refs/heads/main:refs/custom/main\n+refs/heads/*:refs/custom/all/*',
    'feature',
    'refs/custom/all/feature'
  ],
  ['+refs/heads/*:refs/custom/all/*\n^refs/heads/feature*', 'feature/nested', null],
  ['refs/heads/main:refs/custom/main', 'feature', null],
  ['', 'feature', null],
  ['+refs/heads/*:refs/../*', 'feature', null]
])('uses exact mapping evidence %s', async (mapping, branch, expected) => {
  const run = vi.fn().mockImplementation(async (args: string[]) => ({
    stdout: args[0] === 'config' ? mapping : 'oid'
  }))
  expect(await readGitRemoteTrackingRef(run, 'origin/team', branch!)).toBe(expected)
  expect(run).toHaveBeenCalledWith(['config', '--get-all', 'remote.origin/team.fetch'])
  if (expected) {
    expect(run).toHaveBeenCalledWith(['rev-parse', '--verify', '--quiet', expected])
  } else {
    expect(run).toHaveBeenCalledOnce()
  }
})

it('does not promote a stale second destination when the first configured mapping is missing', async () => {
  const run = vi.fn().mockImplementation(async (args: string[]) => {
    if (args[0] === 'config') {
      return { stdout: '+refs/heads/*:refs/custom/*\n+refs/heads/*:refs/remotes/origin/*' }
    }
    if (args.at(-1) === 'refs/custom/feature') {
      throw Object.assign(new Error('missing'), { code: 1 })
    }
    return { stdout: 'stale' }
  })
  expect(await readGitRemoteTrackingRef(run, 'origin', 'feature')).toBeNull()
  expect(run).not.toHaveBeenCalledWith([
    'rev-parse',
    '--verify',
    '--quiet',
    'refs/remotes/origin/feature'
  ])
})

it.each([
  ['feature:refs/custom/feature', 'refs/custom/feature'],
  ['heads/feature:refs/custom/feature', 'refs/custom/feature'],
  ['feature:custom', 'refs/heads/custom'],
  ['feature:heads/tracked', 'refs/heads/tracked'],
  ['feature:remotes/origin/tracked', 'refs/remotes/origin/tracked'],
  ['refs/tags/feature:refs/custom/tag', null],
  ['feature*:refs/custom/wild*', null]
])(
  'resolves Git exact abbreviations separately from wildcard patterns %s',
  async (mapping, expected) => {
    const run = vi.fn(async (args: string[]) => ({
      stdout:
        args[0] === 'config'
          ? mapping!
          : args[0] === 'ls-remote'
            ? 'oid\trefs/heads/feature'
            : 'oid'
    }))
    expect(await readGitRemoteTrackingRef(run, 'origin', 'feature')).toBe(expected)
  }
)
