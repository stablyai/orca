import { getDefaultSettings } from '../../../../../shared/constants'
import type { AgentWorkspaceTrustDecision } from '../../../../../shared/agent-workspace-trust-decision'
import type { Repo } from '../../../../../shared/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RepositoryAgentTrustSection } from './RepositoryAgentTrustSection'

function repo(agentWorkspaceTrust?: AgentWorkspaceTrustDecision): Repo {
  return {
    id: 'repo-1',
    path: '/repos/acme-web',
    displayName: 'acme-web',
    badgeColor: '#3b82f6',
    addedAt: 0,
    ...(agentWorkspaceTrust ? { agentWorkspaceTrust } : {})
  }
}

function fixture(decision: AgentWorkspaceTrustDecision | undefined, globalEnabled = true) {
  return defineFixture({
    width: 640,
    store: {
      settings: {
        ...getDefaultSettings('/home/fixture'),
        agentWorkspaceTrustEnabled: globalEnabled
      }
    },
    render: () => <RepositoryAgentTrustSection repo={repo(decision)} updateRepo={() => {}} />
  })
}

export const undecided = fixture(undefined)
export const preTrust = fixture('pre-trust')
export const agentAsks = fixture('agent-asks')
export const globalOff = fixture('pre-trust', false)
