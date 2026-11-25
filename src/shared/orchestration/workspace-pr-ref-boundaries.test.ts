import { expect, it } from 'vitest'
import { checkWorkspacePullRequests, type WorkspacePrSnapshot } from './workspace-pr-check'
import type { Repo } from '../repository/repo-types'

const repos: Repo[] = ['p', 'q', 'e'].map((id) => ({
  id,
  path: `/${id}`,
  displayName: id,
  badgeColor: '',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: `${id === 'e' ? 'git.example' : 'github.com'}/org/${id}`,
    remoteName: 'origin',
    remoteUrl: ''
  }
}))
const ref = { forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }
const check = (subject: string, spec = '', primaries = ['p::/p/work']) => {
  const snapshot: WorkspacePrSnapshot = {
    repos,
    primaries,
    metadata: () => undefined,
    lineage: {},
    workspaceLineage: {},
    crossStoreLineage: {},
    uncertainty: {},
    folders: []
  }
  return checkWorkspacePullRequests(snapshot, { subject, spec, body: '', host: 'local' })
}

it.each([
  'xhttps://github.com/org/q/pull/17',
  '𐐀https://github.com/org/q/pull/17',
  'https://github.com/org/q/pull/17-fake',
  'https://github.com/org/q/pull/17.fake',
  'https://foreign.example/?redirect=https://github.com/org/q/pull/17'
])('does not invent a report reference from %s', (subject) => {
  expect(check(subject)).toEqual({ version: 1, state: 'complete', outside: [] })
})

it.each([
  'xhttps://github.com/org/q/pull/17',
  '𐐀https://github.com/org/q/pull/17',
  'https://github.com/org/q/pull/17-fake',
  'https://github.com/org/q/pull/17.fake',
  'https://foreign.example/?redirect=https://github.com/org/q/pull/17'
])('does not suppress a warning for an invalid assigned URL: %s', (spec) => {
  expect(check('https://github.com/org/q/pull/17', spec)).toEqual({
    version: 1,
    state: 'complete',
    outside: [ref]
  })
})

it.each([
  '(https://github.com/org/q/pull/17).',
  '<https://github.com/org/q/pull/17>',
  "'https://github.com/org/q/pull/17'",
  '[https://github.com/org/q/pull/17]',
  '{https://github.com/org/q/pull/17}',
  'https://github.com/org/q/pull/17/files?diff=split#discussion'
])('retains punctuation and provider paths: %s', (url) => {
  expect(check(url)).toEqual({ version: 1, state: 'complete', outside: [ref] })
  expect(check('org/q#17', url)).toEqual({ version: 1, state: 'complete', outside: [] })
})

it('does not let an embedded duplicate hide a later valid report URL', () => {
  expect(check('xhttps://github.com/org/q/pull/17 https://github.com/org/q/pull/17')).toEqual({
    version: 1,
    state: 'complete',
    outside: [ref]
  })
})

it.each([['folder:primary'], ['p::/p/work', 'e::/e/work']])(
  'keeps a matching assigned short reference unknown without one primary forge: %j',
  (...primaries) => {
    expect(check('https://github.com/org/q/pull/17', 'org/q#17', primaries)).toEqual({
      version: 1,
      state: 'partial',
      outside: []
    })
    expect(check('https://github.com/org/q/pull/17', 'org/elsewhere#17', primaries)).toEqual({
      version: 1,
      state: 'complete',
      outside: [ref]
    })
  }
)

// One grammar both ways: a path that only names Q#17 after URL normalization is no reference at all,
// whether it appears in the report or in the assignment.
const NORMALIZED_ONLY = [
  'https://github.com/org/q/pull/./17',
  'https://github.com/org/q/pull/%2e/17',
  'https://github.com/org/x/../q/pull/17',
  'https://github.com/org/q/pull/18/../17',
  'https://github.com/org\\q/pull/17'
]

it.each(NORMALIZED_ONLY)('does not read a report reference from %s', (subject) => {
  expect(check(subject)).toEqual({ version: 1, state: 'complete', outside: [] })
  expect(check(`${subject} https://github.com/org/q/pull/17`)).toEqual({
    version: 1,
    state: 'complete',
    outside: [ref]
  })
})

it.each(NORMALIZED_ONLY)('does not read an assigned reference from %s', (spec) => {
  expect(check('https://github.com/org/q/pull/17', spec)).toEqual({
    version: 1,
    state: 'complete',
    outside: [ref]
  })
  expect(check('org/q#17', spec)).toEqual({ version: 1, state: 'complete', outside: [ref] })
})

it.each([
  'https://github.com/org/q/pull/17',
  'https://github.com/org/q/pull/17/',
  'https://github.com/org/q/pull/17.',
  'https://GitHub.com/org/q/pull/17',
  'https://github.com/org/q/pull/17/commits/abc'
])('keeps the canonical spelling in both directions: %s', (url) => {
  expect(check(url)).toEqual({ version: 1, state: 'complete', outside: [ref] })
  expect(check(url, url)).toEqual({ version: 1, state: 'complete', outside: [] })
  expect(check('org/q#17', url)).toEqual({ version: 1, state: 'complete', outside: [] })
})

// A suffix after the PR number may normalize (dot segments, encoded dots) without touching the PR:
// both the literal and the normalized PR prefix name the same Q#17, so both sides read it.
const SAME_PR_SUFFIX = [
  'https://github.com/org/q/pull/17/files/../commits',
  'https://github.com/org/q/pull/17/files/%2e%2e/commits',
  'https://github.com/org/q/pull/17/./files',
  'https://github.com/org/q/pull/17/files/../commits.'
]

it.each(SAME_PR_SUFFIX)('reads the same pull request through a normalized suffix: %s', (url) => {
  expect(check(url)).toEqual({ version: 1, state: 'complete', outside: [ref] })
  expect(check(url, url)).toEqual({ version: 1, state: 'complete', outside: [] })
  expect(check(url, 'https://github.com/org/q/pull/17')).toEqual({
    version: 1,
    state: 'complete',
    outside: []
  })
  expect(check('https://github.com/org/q/pull/17', url)).toEqual({
    version: 1,
    state: 'complete',
    outside: []
  })
  expect(check('org/q#17', url)).toEqual({ version: 1, state: 'complete', outside: [] })
})

// A suffix that normalizes the PR away or into another one is no reference on either side.
const SUFFIX_CHANGES_PR = [
  'https://github.com/org/q/pull/17/../18',
  'https://github.com/org/q/pull/17/../../../r/pull/17',
  'https://github.com/org/q/pull/17/../',
  'https://github.com/org/q/pull/17/%2e%2e/18'
]

it.each(SUFFIX_CHANGES_PR)('does not read a pull request a suffix changes: %s', (url) => {
  expect(check(url)).toEqual({ version: 1, state: 'complete', outside: [] })
  expect(check('https://github.com/org/q/pull/17', url)).toEqual({
    version: 1,
    state: 'complete',
    outside: [ref]
  })
  expect(check('org/q#17', url)).toEqual({ version: 1, state: 'complete', outside: [ref] })
})

it('keeps host and forge identity through a normalized suffix', () => {
  expect(check('https://git.example/org/e/pull/17/files/../commits')).toEqual({
    version: 1,
    state: 'complete',
    outside: [{ forgeHost: 'git.example', owner: 'org', repo: 'e', number: 17 }]
  })
  expect(check('https://unknown.example/org/q/pull/17/files/../commits')).toEqual({
    version: 1,
    state: 'complete',
    outside: []
  })
  expect(
    check('https://github.com/org/q/pull/17', 'https://git.example/org/q/pull/17/files/../x')
  ).toEqual({ version: 1, state: 'complete', outside: [ref] })
})
