import type { BundledSkillOp, BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
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

function coverage(host?: AgentSkillHostScope): React.JSX.Element {
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

export const thisMachine = defineFixture({
  width: 560,
  render: () => coverage({ hostId: 'local', label: 'This machine' })
})

export const wslDistro = defineFixture({
  width: 560,
  render: () => coverage({ hostId: 'local', label: 'WSL Ubuntu' })
})

export const remoteServer = defineFixture({
  width: 560,
  render: () => coverage({ hostId: 'runtime:build-box', label: 'build-box' })
})

export const unresolvedHost = defineFixture({
  width: 560,
  render: () => coverage()
})
