import { describe, expect, it } from 'vitest'
import { checkWorkspacePullRequests, type WorkspacePrSnapshot } from './workspace-pr-check'
import type { Repo } from '../repository/repo-types'
import { LineageUncertaintyKeyIndex } from '../worktree/lineage/lineage-uncertainty'
import { buildLineageChildIndex } from './lineage-child-index'

const p: Repo = {
  id: 'p',
  path: '/p',
  displayName: 'p',
  badgeColor: '',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/org/p',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/org/p'
  }
}
const q: Repo = {
  ...p,
  id: 'q',
  path: '/q',
  gitRemoteIdentity: {
    canonicalKey: 'github.com/org/q',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/org/q'
  }
}
const snapshot = (): WorkspacePrSnapshot => ({
  repos: [p, q],
  metadata: () => undefined,
  lineage: {},
  workspaceLineage: {},
  crossStoreLineage: {},
  uncertainty: {},
  folders: [],
  primaries: ['p::/p/work']
})
const ref = { forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }
// Every case also runs with the Store's child index: it must answer exactly as the full scan does.
const check = (spec = '', input = snapshot(), subject = 'Opened org/q#17') => {
  const report = { subject, body: '', spec, host: 'local' }
  const scanned = checkWorkspacePullRequests(input, report)
  const records = [input.lineage, input.workspaceLineage, input.crossStoreLineage] as const
  const indexed = {
    ...input,
    childIndex: (limit: number) => buildLineageChildIndex(records, limit)
  }
  expect(checkWorkspacePullRequests(indexed, report)).toEqual(scanned)
  return scanned
}

describe('completion report repository coverage', () => {
  it('warns for an uncovered registered repository', () => {
    expect(check()).toEqual({ version: 1, state: 'complete', outside: [ref] })
  })
  it.each([
    'org/q#17',
    'see #17',
    'https://github.com/org/q/pull/17',
    'https://github.com:443/org/q/pull/17',
    'a/b#1 a/b#2 a/b#3 a/b#4 a/b#5 org/q#17'
  ])('excludes exactly assigned PRs: %s', (spec) => {
    expect(check(spec)).toEqual({ version: 1, state: 'complete', outside: [] })
  })
  it.each(['org/p#17', 'org/q#170', '#170', 'https://github.com/org/q/pull/170'])(
    'does not confuse repo or number prefixes: %s',
    (spec) => {
      expect(check(spec)).toEqual({ version: 1, state: 'complete', outside: [ref] })
    }
  )
  it('keeps erased folder ancestry unknown even without child metadata', () => {
    expect(
      check('', { ...snapshot(), uncertainty: { '["local","worktree:q::/q/child"]': true } })
    ).toEqual({ version: 1, state: 'partial', outside: [] })
  })
  it('does not apply another host marker on this host', () => {
    expect(
      check('', { ...snapshot(), uncertainty: { '["ssh:remote","worktree:q::/q/child"]': true } })
    ).toEqual({ version: 1, state: 'complete', outside: [ref] })
  })
  it.each([null, [], { broken: true }, { '["local","worktree:q::/q/child"]': false }])(
    'fails quiet on corrupt persisted uncertainty: %j',
    (uncertainty) => {
      expect(check('', { ...snapshot(), uncertainty })).toEqual({
        version: 1,
        state: 'partial',
        outside: []
      })
    }
  )
  it('does not claim absence when spec is truncated', () => {
    expect(check(`${' '.repeat(65536)}org/q#17`)).toEqual({
      version: 1,
      state: 'partial',
      outside: []
    })
  })
  it('does not parse foreign forge URLs as short GitHub references', () => {
    expect(
      check(
        '',
        snapshot(),
        'https://foreign.example/org/q/pull/17 and https://foreign.example/org/q#17'
      )
    ).toEqual({ version: 1, state: 'complete', outside: [] })
  })
  it.each([
    'https://foreign.example/path?x=#17',
    'https://foreign.example/a/#17',
    'xorg/q#17x',
    'org/q#170',
    '#170'
  ])('does not assign a token embedded in another token: %s', (spec) => {
    expect(check(spec)).toEqual({ version: 1, state: 'complete', outside: [ref] })
  })
  it('keeps a depth-five untagged descendant possible', () => {
    const input = snapshot()
    input.metadata = (id) => ({ instanceId: id, createdAt: 1 })
    input.lineage = {
      'q::/q/one': {
        worktreeId: 'q::/q/one',
        worktreeInstanceId: 'q::/q/one',
        parentWorktreeId: 'p::/p/work',
        parentWorktreeInstanceId: 'p::/p/work',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      },
      'q::/q/two': {
        worktreeId: 'q::/q/two',
        worktreeInstanceId: 'q::/q/two',
        parentWorktreeId: 'q::/q/one',
        parentWorktreeInstanceId: 'q::/q/one',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      },
      'q::/q/three': {
        worktreeId: 'q::/q/three',
        worktreeInstanceId: 'q::/q/three',
        parentWorktreeId: 'q::/q/two',
        parentWorktreeInstanceId: 'q::/q/two',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      },
      'q::/q/four': {
        worktreeId: 'q::/q/four',
        worktreeInstanceId: 'q::/q/four',
        parentWorktreeId: 'q::/q/three',
        parentWorktreeInstanceId: 'q::/q/three',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      },
      'q::/q/five': {
        worktreeId: 'q::/q/five',
        worktreeInstanceId: 'q::/q/five',
        parentWorktreeId: 'q::/q/four',
        parentWorktreeInstanceId: 'q::/q/four',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }
    expect(check('', input)).toEqual({ version: 1, state: 'partial', outside: [] })
    input.metadata = () => undefined
    expect(check('', input)).toEqual({ version: 1, state: 'partial', outside: [] })
  })
  it('keeps unknown-host erased children possible on either host', () => {
    expect(
      check('', { ...snapshot(), uncertainty: { '[null,"worktree:q::/q/child"]': true } })
    ).toEqual({ version: 1, state: 'partial', outside: [] })
  })
  it('makes an exhausted lineage scan unknown instead of proving absence', () => {
    const uncertainty = Object.fromEntries(
      Array.from({ length: 5001 }, (_, n) => [
        JSON.stringify(['ssh:elsewhere', `worktree:q::/q/${n}`]),
        true
      ])
    )
    expect(check('', { ...snapshot(), uncertainty })).toEqual({
      version: 1,
      state: 'partial',
      outside: []
    })
  })
  it('keeps the lineage row limit when the rows belong to unrelated projects', () => {
    const lineage = Object.fromEntries(
      Array.from({ length: 5001 }, (_, n) => [
        `r::/r/${n}`,
        {
          worktreeId: `r::/r/${n}`,
          worktreeInstanceId: `i${n}`,
          parentWorktreeId: 'r::/r/root',
          parentWorktreeInstanceId: 'root',
          origin: 'cli' as const,
          capture: { source: 'explicit-cli-flag' as const, confidence: 'explicit' as const },
          createdAt: 1
        }
      ])
    )
    const r: Repo = {
      ...p,
      id: 'r',
      path: '/r',
      gitRemoteIdentity: { ...p.gitRemoteIdentity!, canonicalKey: 'github.com/org/r' }
    }
    expect(check('', { ...snapshot(), repos: [p, q, r], lineage })).toEqual({
      version: 1,
      state: 'partial',
      outside: []
    })
  })
  it('does not confuse enterprise URL spans with public short references', () => {
    const enterprise = {
      ...q,
      id: 'e',
      gitRemoteIdentity: {
        canonicalKey: 'git.example/org/q',
        remoteName: 'origin',
        remoteUrl: 'https://git.example/org/q'
      }
    }
    expect(
      check('', { ...snapshot(), repos: [p, q, enterprise] }, 'https://git.example/org/q/pull/17')
    ).toEqual({
      version: 1,
      state: 'complete',
      outside: [{ forgeHost: 'git.example', owner: 'org', repo: 'q', number: 17 }]
    })
    expect(
      check(
        'org/q#17',
        { ...snapshot(), repos: [p, q, enterprise] },
        'https://git.example/org/q/pull/17'
      )
    ).toEqual({
      version: 1,
      state: 'complete',
      outside: [{ forgeHost: 'git.example', owner: 'org', repo: 'q', number: 17 }]
    })
  })
  it('does not consume more than the UTF-8 report budget', () => {
    expect(check('', snapshot(), `${'🙂'.repeat(4096)} org/q#17`)).toEqual({
      version: 1,
      state: 'complete',
      outside: []
    })
  })
  it('keeps a qualified report unknown when the primary forge is unavailable', () => {
    expect(
      check('', { ...snapshot(), repos: [{ ...p, gitRemoteIdentity: undefined }, q] })
    ).toEqual({ version: 1, state: 'partial', outside: [] })
  })
  it('keeps an unregistered report repository unknown', () => {
    expect(check('', snapshot(), 'elsewhere/repo#17')).toEqual({
      version: 1,
      state: 'partial',
      outside: []
    })
  })
  it('does not turn a clipped foreign URL query into an assigned short reference', () => {
    expect(check(`https://foreign.example/${'x'.repeat(600)}?ref=org/q#17`)).toEqual({
      version: 1,
      state: 'partial',
      outside: []
    })
  })
  it('rechecks marker flags after their immutable keys have been indexed', () => {
    const index = new LineageUncertaintyKeyIndex()
    const uncertainty: Record<string, unknown> = { '["local","worktree:p::/p/old"]': true }
    const input = {
      ...snapshot(),
      uncertainty,
      decodeUncertaintyKey: (key: string) => index.decode(key)
    }
    expect(check('', input)).toEqual({ version: 1, state: 'complete', outside: [ref] })
    uncertainty['["local","worktree:p::/p/old"]'] = false
    expect(check('', input)).toEqual({ version: 1, state: 'partial', outside: [] })
  })
})
