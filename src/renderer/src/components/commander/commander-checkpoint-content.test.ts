import { expect, it } from 'vitest'
import {
  checkpointMarkdown,
  checkpointSources,
  checkpointObservation,
  confirmsNoAgents
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
