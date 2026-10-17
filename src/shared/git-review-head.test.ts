import { describe, expect, it } from 'vitest'
import { parseGitConfigListSnapshot } from './git-config-snapshot-runner'
import { readReviewHead } from './git-review-head'

// Captured from `git config --list -z` (git 2.54) in a scratch repo with these branches, keeping only
// the remote/branch/push records. `git push --dry-run` there sent `own` to origin, `tri` to fork and
// `url-remote` to fork, and refused `tracks-develop`, `tracks-upstream-develop`, `feature-x-2`, `pr-7`.
const CAPTURED_CONFIG: [string, string][] = [
  ['remote.origin.url', '../upstream.git'],
  ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
  ['remote.upstream.url', '../upstream.git'],
  ['remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*'],
  ['remote.fork.url', '../fork.git'],
  ['remote.fork.fetch', '+refs/heads/*:refs/remotes/fork/*'],
  ['remote.alice.url', '../alice.git'],
  ['remote.alice.fetch', '+refs/heads/*:refs/remotes/alice/*'],
  ['branch.own.remote', 'origin'],
  ['branch.own.merge', 'refs/heads/own'],
  ['branch.tracks-develop.remote', 'origin'],
  ['branch.tracks-develop.merge', 'refs/heads/develop'],
  ['branch.tracks-upstream-develop.remote', 'upstream'],
  ['branch.tracks-upstream-develop.merge', 'refs/heads/develop'],
  ['branch.tri.remote', 'origin'],
  ['branch.tri.merge', 'refs/heads/main'],
  ['branch.tri.pushremote', 'fork'],
  ['branch.feature-x-2.remote', 'alice'],
  ['branch.feature-x-2.merge', 'refs/heads/feature-x'],
  ['branch.pr-7.remote', 'origin'],
  ['branch.pr-7.merge', 'refs/pull/7/head'],
  ['branch.url-remote.remote', '../fork.git'],
  ['branch.url-remote.merge', 'refs/heads/url-remote']
]

function configWith(extra: [string, string][] = []) {
  return parseGitConfigListSnapshot(
    [...CAPTURED_CONFIG, ...extra].map(([key, value]) => `${key}\n${value}`).join('\0')
  )
}

describe('readReviewHead', () => {
  it.each([
    ['own', { kind: 'branch', remote: 'origin', branch: 'own' }],
    // #26948: tracking the base branch must not make develop's PR this branch's.
    ['tracks-develop', { kind: 'branch', remote: 'origin', branch: 'tracks-develop' }],
    [
      'tracks-upstream-develop',
      { kind: 'branch', remote: 'upstream', branch: 'tracks-upstream-develop' }
    ],
    ['tri', { kind: 'branch', remote: 'fork', branch: 'tri' }],
    // A contributor fork's branch checked out under another local name, as create-from-PR does.
    ['feature-x-2', { kind: 'branch', remote: 'alice', branch: 'feature-x' }],
    ['pr-7', { kind: 'review', number: 7 }],
    ['url-remote', { kind: 'branch', remote: 'fork', branch: 'url-remote' }],
    ['never-pushed', { kind: 'branch', remote: 'origin', branch: 'never-pushed' }]
  ])('follows where %s is pushed', (branch, head) => {
    expect(readReviewHead(configWith(), branch)).toEqual(head)
  })

  it('follows the tracked name when push.default pushes to the upstream branch', () => {
    const config = configWith([['push.default', 'upstream']])
    expect(readReviewHead(config, 'tracks-develop')).toEqual({
      kind: 'branch',
      remote: 'origin',
      branch: 'develop'
    })
  })

  it('sends every branch without its own push remote to remote.pushDefault', () => {
    const config = configWith([['remote.pushdefault', 'fork']])
    expect(readReviewHead(config, 'own')).toEqual({ kind: 'branch', remote: 'fork', branch: 'own' })
    expect(readReviewHead(config, 'tracks-develop')).toEqual({
      kind: 'branch',
      remote: 'fork',
      branch: 'tracks-develop'
    })
  })

  it('reads a glab merge-request checkout as a link to that review', () => {
    const config = configWith([
      ['branch.mr-9.remote', 'origin'],
      ['branch.mr-9.merge', 'refs/merge-requests/9/head']
    ])
    expect(readReviewHead(config, 'mr-9')).toEqual({ kind: 'review', number: 9 })
  })

  it('defaults to origin when git config could not be read', () => {
    expect(readReviewHead(new Map(), 'feature')).toEqual({
      kind: 'branch',
      remote: 'origin',
      branch: 'feature'
    })
  })
})
