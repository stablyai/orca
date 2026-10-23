import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { planEntry, planOf, planOp } from '../skills/bundled-skill-plan-fixtures.test-support'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'

const useDetectedAgents = vi.fn(() => ({
  detectedIds: ['claude', 'codex'],
  isLoading: false,
  isRefreshing: false,
  refresh: vi.fn()
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (...args: unknown[]) => useDetectedAgents(...(args as []))
}))

describe('OrchestrationSkillAgentCoverage', () => {
  it('shows each detected agent with an explicit skill status', () => {
    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        sources={[
          {
            id: 'claude-home',
            label: 'Claude Code home',
            path: '/Users/test/.claude/skills',
            sourceKind: 'home',
            providers: ['claude'],
            owner: 'claude',
            exists: true
          }
        ]}
        skills={[
          {
            id: 'claude-skill',
            name: 'orchestration',
            description: null,
            providers: ['claude'],
            sourceKind: 'home',
            sourceLabel: 'Claude Code home',
            rootPath: '/Users/test/.claude/skills',
            directoryPath: '/Users/test/.claude/skills/orchestration',
            skillFilePath: '/Users/test/.claude/skills/orchestration/SKILL.md',
            installed: true,
            updatedAt: null
          }
        ]}
      />
    )

    expect(markup).toContain('Claude')
    expect(markup).toContain('Codex')
    expect(markup).toContain('Ready')
    expect(markup).toContain('Missing')
    expect(markup).not.toContain('View details')
    // Why: an omitted target reads as "host unknown", which pins detectedIds to
    // null and leaves the widget spinning forever.
    expect(useDetectedAgents).toHaveBeenCalledWith({ kind: 'local' })
  })
})

it('uses the install plan to mark an agent missing even when discovery finds a shared copy', () => {
  const markup = renderToStaticMarkup(
    <OrchestrationSkillAgentCoverage
      loading={false}
      plan={planOf([
        planEntry('orchestration', [
          planOp('keep', '/home/u/.agents/skills/orchestration', {
            agents: ['codex'],
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'a'.repeat(64) }
          }),
          planOp('link', '/home/u/.claude/skills/orchestration', { agents: ['claude'] })
        ])
      ])}
      sources={['claude', 'codex'].map((owner) => ({
        id: owner,
        label: owner,
        path: '/home/u/.agents/skills',
        sourceKind: 'home',
        providers: [],
        owner,
        exists: true
      }))}
      skills={[
        {
          id: 'skill',
          name: 'orchestration',
          description: null,
          providers: ['claude', 'codex'],
          sourceKind: 'home',
          sourceLabel: 'Shared',
          rootPath: '/home/u/.agents/skills',
          directoryPath: '/home/u/.agents/skills/orchestration',
          skillFilePath: '/home/u/.agents/skills/orchestration/SKILL.md',
          installed: true,
          updatedAt: null
        }
      ]}
    />
  )
  expect(markup).toContain('1 of 2 detected agents have the skill.')
  expect(markup).toContain('Missing')
  expect(markup).not.toContain('All 2 detected agents')
})

it('uses the remote plan for coverage when local discovery and detection disagree', () => {
  const markup = renderToStaticMarkup(
    <OrchestrationSkillAgentCoverage
      loading={true}
      sources={[]}
      skills={[]}
      plan={planOf([
        planEntry('orchestration', [
          planOp('keep', '/home/remote/.agents/skills/orchestration', {
            agents: ['opencode'],
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'a'.repeat(64) }
          }),
          planOp('keep', '/home/remote/.cursor/skills/orchestration', {
            agents: ['cursor'],
            observed: { kind: 'link', target: '/home/remote/.agents/skills/orchestration' }
          }),
          planOp('link', '/home/remote/.gemini/skills/orchestration', { agents: ['gemini'] })
        ])
      ])}
    />
  )
  expect(markup).toContain('2 of 3 detected agents have the skill.')
  expect(markup).toContain('OpenCode')
  expect(markup).toContain('Cursor')
  expect(markup).toContain('Gemini')
  expect(markup).toContain('Ready')
  expect(markup).toContain('Missing')
  expect(markup).not.toContain('Claude')
  expect(markup).not.toContain('Codex')
})

it('shows full host coverage without waiting for discovery to see the installed copies', () => {
  const markup = renderToStaticMarkup(
    <OrchestrationSkillAgentCoverage
      loading={false}
      sources={[]}
      skills={[]}
      plan={planOf([
        planEntry('orchestration', [
          planOp('keep', '/home/remote/.agents/skills/orchestration', {
            agents: ['opencode', 'codex'],
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'a'.repeat(64) }
          }),
          planOp('keep', '/home/remote/.claude/skills/orchestration', {
            agents: ['claude'],
            observed: { kind: 'link', target: '/home/remote/.agents/skills/orchestration' }
          })
        ])
      ])}
    />
  )
  expect(markup).toContain('All 3 detected agents have the skill.')
  expect(markup).not.toContain('Missing')
})

it.each([
  { name: 'foreign file', observed: { kind: 'file', mtimeMs: 1 }, label: 'Missing' },
  {
    name: 'empty folder',
    observed: { kind: 'folder', entries: [], skillDigest: null },
    label: 'Missing'
  },
  { name: 'unverified link', observed: { kind: 'link', target: '/missing' }, label: 'Missing' },
  { name: 'unreadable entry', observed: { kind: 'unreadable' }, label: 'Needs attention' },
  {
    name: 'unreadable skill file',
    observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: null },
    label: 'Needs attention'
  }
] as const)('does not mark the $name Ready', ({ observed, label }) => {
  const markup = renderToStaticMarkup(
    <OrchestrationSkillAgentCoverage
      loading={false}
      sources={[]}
      skills={[]}
      plan={planOf([
        planEntry('orchestration', [
          planOp('leave', '/home/u/.claude/skills/orchestration', {
            observed,
            reason: observed.kind === 'unreadable' ? 'unreadable' : 'other'
          })
        ])
      ])}
    />
  )
  expect(markup).toContain('Claude')
  expect(markup).toContain(label)
  expect(markup).not.toContain('Ready')
  expect(markup).not.toContain('All 1 detected agent has the skill.')
  if (label === 'Needs attention') {
    expect(markup).not.toContain('Missing')
  }
})

it('counts readable edited copies and verified links to them as usable', () => {
  const markup = renderToStaticMarkup(
    <OrchestrationSkillAgentCoverage
      loading={false}
      sources={[]}
      skills={[]}
      plan={planOf([
        planEntry('orchestration', [
          planOp('leave', '/home/u/.agents/skills/orchestration', {
            agents: ['codex'],
            reason: 'edited',
            observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'c'.repeat(64) }
          }),
          planOp('leave', '/home/u/.claude/skills/orchestration', {
            reason: 'shared-not-current',
            observed: { kind: 'link', target: '/home/u/.agents/skills/orchestration' }
          })
        ])
      ])}
    />
  )
  expect(markup).toContain('All 2 detected agents have the skill.')
  expect(markup).not.toContain('Missing')
})

it.each([
  { kind: 'unreadable' },
  { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: null }
] as const)(
  'needs attention when a verified link has an unreadable shared skill ($kind)',
  (observed) => {
    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        sources={[]}
        skills={[]}
        plan={planOf([
          planEntry('orchestration', [
            planOp('leave', '/home/u/.agents/skills/orchestration', {
              observed,
              reason: observed.kind === 'unreadable' ? 'unreadable' : 'other'
            }),
            planOp('leave', '/home/u/.claude/skills/orchestration', {
              reason: 'shared-not-current',
              observed: { kind: 'link', target: '/home/u/.agents/skills/orchestration' }
            })
          ])
        ])}
      />
    )
    expect(markup).toContain('Needs attention')
    expect(markup).not.toContain('Ready')
    expect(markup).not.toContain('Missing')
    expect(markup).not.toContain('All 1 detected agent has the skill.')
  }
)
