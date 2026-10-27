import type { BundledSkillOp, BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'
import type { AgentSkillHostScope } from './use-agent-skill-host-scope'

function op(path: string, extra: Partial<BundledSkillOp>): BundledSkillOp {
  return {
    kind: 'link',
    path,
    role: 'agent',
    agents: [],
    observed: { kind: 'absent' },
    cleanup: [],
    ...extra
  }
}

// Codex reads the shared copy; Claude and Gemini still need their links.
const plan: BundledSkillPlan = {
  scope: 'global',
  homeDirectory: '/home/u',
  planDigest: 'b'.repeat(64),
  skills: [
    {
      name: 'orchestration',
      digest: 'a'.repeat(64),
      ops: [
        op('/home/u/.agents/skills/orchestration', {
          kind: 'keep',
          role: 'shared',
          agents: ['codex'],
          observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'a'.repeat(64) }
        }),
        op('/home/u/.claude/skills/orchestration', { agents: ['claude'] }),
        op('/home/u/.gemini/skills/orchestration', { agents: ['gemini'] })
      ]
    }
  ]
}

function coverage(host: AgentSkillHostScope): React.JSX.Element {
  return (
    <div className="p-5">
      <OrchestrationSkillAgentCoverage
        embedded
        plan={plan}
        host={host}
        skills={[]}
        sources={[]}
        loading={false}
      />
    </div>
  )
}

// The WSL bridge has no plan: chips come from the distro scan and this machine's detected agents.
const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\u'
const wslSources: SkillDiscoverySource[] = (['claude', 'codex', 'gemini'] as const).map(
  (owner) => ({
    id: `${owner}-home`,
    label: `${owner} home`,
    path: `${WSL_HOME}\\.${owner}\\skills`,
    sourceKind: 'home',
    providers: [],
    owner,
    exists: true
  })
)
const wslSkills: DiscoveredSkill[] = [
  {
    id: 'claude-orchestration',
    name: 'orchestration',
    description: null,
    providers: ['claude'],
    sourceKind: 'home',
    sourceLabel: 'claude home',
    rootPath: `${WSL_HOME}\\.claude\\skills`,
    directoryPath: `${WSL_HOME}\\.claude\\skills\\orchestration`,
    skillFilePath: `${WSL_HOME}\\.claude\\skills\\orchestration\\SKILL.md`,
    installed: true,
    updatedAt: null
  }
]

export const thisMachine = defineFixture({
  width: 560,
  render: () => coverage({ hostId: 'local', label: 'This machine' })
})

export const wslDistro = defineFixture({
  width: 560,
  store: { detectedAgentIds: ['claude', 'codex', 'gemini'], isDetectingAgents: false },
  render: () => (
    <div className="p-5">
      <OrchestrationSkillAgentCoverage
        embedded
        host={{ hostId: 'local', label: 'WSL Ubuntu' }}
        skills={wslSkills}
        sources={wslSources}
        loading={false}
      />
    </div>
  )
})

export const remoteServer = defineFixture({
  width: 560,
  render: () => coverage({ hostId: 'runtime:build-box', label: 'build-box' })
})
