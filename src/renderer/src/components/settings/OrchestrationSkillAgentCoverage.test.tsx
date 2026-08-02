import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'

const useDetectedAgents = vi.fn(() => ({
  detectedIds: ['claude', 'codex'],
  isLoading: false,
  detectionFailed: false,
  isRefreshing: false,
  refresh: vi.fn()
}))
const useActiveSkillDiscoveryRuntimeTarget = vi.fn<() => RuntimeClientTarget | null>(() => ({
  kind: 'local'
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (...args: unknown[]) => useDetectedAgents(...(args as []))
}))

vi.mock('@/hooks/use-active-skill-discovery-runtime-target', () => ({
  useActiveSkillDiscoveryRuntimeTarget: () => useActiveSkillDiscoveryRuntimeTarget()
}))

const claudeHomeSource: SkillDiscoverySource = {
  id: 'claude-home',
  label: 'Claude home',
  path: '/Users/test/.claude/skills',
  sourceKind: 'home',
  providers: ['claude'],
  owner: 'claude',
  exists: true
}

const claudeHomeSkill: DiscoveredSkill = {
  id: 'claude-skill',
  name: 'orchestration',
  description: null,
  providers: ['claude'],
  sourceKind: 'home',
  sourceLabel: 'Claude home',
  rootPath: '/Users/test/.claude/skills',
  directoryPath: '/Users/test/.claude/skills/orchestration',
  skillFilePath: '/Users/test/.claude/skills/orchestration/SKILL.md',
  installed: true,
  fileCount: 1,
  updatedAt: null
}

describe('OrchestrationSkillAgentCoverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useActiveSkillDiscoveryRuntimeTarget.mockReturnValue({ kind: 'local' })
  })

  it('shows each detected agent with an explicit skill status', () => {
    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        sources={[claudeHomeSource]}
        skills={[claudeHomeSkill]}
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

  it('detects agents on the focused runtime host that produced the skill scan', () => {
    useActiveSkillDiscoveryRuntimeTarget.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-1'
    })

    renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        sources={[claudeHomeSource]}
        skills={[claudeHomeSkill]}
      />
    )

    // Why: skills/sources come from the remote scan; matching them against
    // local agent ids reports wrong Ready/Missing chips.
    expect(useDetectedAgents).toHaveBeenCalledWith({
      kind: 'runtime',
      environmentId: 'env-1'
    })
  })

  it('stays loading while the skill-scan host is unresolved', () => {
    useActiveSkillDiscoveryRuntimeTarget.mockReturnValue(null)
    // Why: Once keeps this loading state from leaking into later tests.
    useDetectedAgents.mockReturnValueOnce({
      detectedIds: null as never,
      isLoading: true,
      detectionFailed: false,
      isRefreshing: false,
      refresh: vi.fn()
    })

    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage loading={false} sources={[]} skills={[]} />
    )

    expect(useDetectedAgents).toHaveBeenCalledWith(undefined)
    expect(markup).toContain('Checking installed agents')
  })

  it('drops out of loading with a retry when the runtime probe failed', () => {
    useActiveSkillDiscoveryRuntimeTarget.mockReturnValue({
      kind: 'environment',
      environmentId: 'env-1'
    })
    // Why: ensureRuntimeDetectedAgents' catch never writes detectedIds, so a
    // failed probe would otherwise leave the card spinning for the whole mount.
    useDetectedAgents.mockReturnValueOnce({
      detectedIds: null as never,
      isLoading: false,
      detectionFailed: true,
      isRefreshing: false,
      refresh: vi.fn()
    })

    const markup = renderToStaticMarkup(
      <OrchestrationSkillAgentCoverage
        loading={false}
        sources={[claudeHomeSource]}
        skills={[claudeHomeSkill]}
      />
    )

    expect(markup).not.toContain('Checking installed agents')
    expect(markup).toContain('reach the host')
    expect(markup).toContain('Retry')
  })
})
