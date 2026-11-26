import { expect, it } from 'vitest'
import {
  checkpointCardSource,
  checkpointMarkdown,
  checkpointSources,
  checkpointObservation,
  confirmsNoAgents,
  missingCheckpointSources,
  qualifyCheckpointSources
} from './commander-checkpoint-content'

it('keeps counts and a bounded, stable Markdown sample for a 300-agent project', () => {
  const cards = Array.from({ length: 300 }, (_, index) => ({
    dotState: index < 100 ? ('blocked' as const) : ('working' as const),
    agentType: 'codex',
    worktreeName: '工作区',
    task: '项目任务'.repeat(60),
    askSummary: index === 0 ? 'A release decision\nis pending' : undefined
  }))
  const summary = checkpointMarkdown(cards)
  expect(summary).toContain('## blocked (100)')
  expect(summary).toContain('## working (200)')
  expect(summary).toContain('A release decision is pending')
  expect(summary).toContain('… 184 more')
  expect(new TextEncoder().encode(summary).byteLength).toBeLessThan(65536)
  expect(checkpointMarkdown(cards.toReversed())).toBe(summary)
})

it('records observations with durable source identities and an explicit verified empty state', () => {
  const source = { hostId: 'runtime:other', repoId: 'backend' }
  const saved = checkpointObservation('', [source, source])
  expect(saved).toContain('No agents reported in the verified project workspaces.')
  expect(checkpointSources(saved)).toEqual([{ hostId: 'runtime:other', repoId: 'backend' }])
  expect(checkpointSources('Earlier checkpoint without scope')).toEqual([])
})

it('requires complete current coverage of the exact registration before replacing an active checkpoint', () => {
  const row = {
    repoId: 'r',
    hostId: 'local',
    liveTerminalCount: 0,
    unverifiableTerminalCount: 0,
    agents: []
  }
  const listing = {
    worktrees: [row],
    truncated: false,
    hostScope: { hostIds: ['local'], omittedHostIds: [] }
  }
  expect(confirmsNoAgents(listing, 'r', 'local')).toBe(true)
  expect(confirmsNoAgents(listing, 'r', 'local', 'missing-or-hidden-workspace')).toBe(false)
  expect(confirmsNoAgents({ ...listing, truncated: true }, 'r', 'local')).toBe(false)
  expect(confirmsNoAgents({ ...listing, hostScope: undefined }, 'r', 'local')).toBe(false)
  expect(confirmsNoAgents({ ...listing, worktrees: [] }, 'r', 'local')).toBe(false)
  expect(confirmsNoAgents(listing, 'r', 'ssh:other')).toBe(false)
  for (const fields of [
    { agents: [{ state: 'working' }] },
    { liveTerminalCount: 1 },
    { unverifiableTerminalCount: 1 },
    { unverifiableTerminalCount: undefined }
  ]) {
    expect(confirmsNoAgents({ ...listing, worktrees: [{ ...row, ...fields }] }, 'r', 'local')).toBe(
      false
    )
  }
})

it('requires a census of the missing worktree even when its sibling remains busy', () => {
  const repo = { hostId: 'local', repoId: 'r' }
  const w1 = { ...repo, worktreeId: 'w1' }
  const w2 = { ...repo, worktreeId: 'w2' }
  expect(missingCheckpointSources(checkpointObservation('Active', [w1, w2]), [w2], [])).toEqual([
    w1
  ])
  expect(missingCheckpointSources(checkpointObservation('Active', [repo]), [w2], [])).toEqual([
    repo
  ])
  expect(missingCheckpointSources(checkpointObservation('', [repo]), [w2], [])).toEqual([])
  const empty = { liveTerminalCount: 0, unverifiableTerminalCount: 0, agents: [] }
  const listing = {
    truncated: false,
    hostScope: { hostIds: ['local'], omittedHostIds: [] },
    worktrees: [
      { ...w1, ...empty },
      { ...w2, ...empty, liveTerminalCount: 1 }
    ]
  }
  expect(confirmsNoAgents(listing, 'r', 'local', 'w1')).toBe(true)
  expect(confirmsNoAgents(listing, 'r', 'local', 'w2')).toBe(false)
  expect(confirmsNoAgents(listing, 'r', 'local')).toBe(false)
})

it('recovers older local sources and requires evidence for a colliding remote worktree', () => {
  const card = { repoId: 'r', worktreeId: 'w' }
  const local = { ...card, hostId: 'local' }
  const remote = { ...card, hostId: 'runtime:other' }
  const ambiguous = { ...card, hostId: '' }
  const known = [{ id: 'r' }]
  const twins = [...known, { id: 'r', executionHostId: 'runtime:other' as const }]
  const oldBody = checkpointObservation('Active', [ambiguous])
  expect(checkpointCardSource(card, known)).toEqual(local)
  expect(qualifyCheckpointSources([ambiguous], known)).toEqual([local])
  expect(missingCheckpointSources(oldBody, [local], known)).toEqual([])
  expect(missingCheckpointSources(oldBody, [local], twins)).toEqual([remote])
  expect(checkpointCardSource(card, twins)).toEqual(ambiguous)
  expect(missingCheckpointSources(oldBody, [ambiguous], twins)).toEqual([local, remote])
})
