import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../shared/repo-types'
import { RepositoryAgentDefaultsSection } from './RepositoryAgentDefaultsSection'
import { RepositoryAgentTrustSection } from './RepositoryAgentTrustSection'

const repo: Repo = {
  id: 'project-defaults',
  path: '/projects/example',
  displayName: 'Example project',
  badgeColor: '',
  addedAt: 1
}
export const before = defineFixture({
  width: 640,
  render: () => <RepositoryAgentTrustSection repo={repo} updateRepo={() => {}} />
})
export const inherited = defineFixture({
  width: 640,
  render: () => <RepositoryAgentDefaultsSection repo={repo} updateRepo={() => {}} />
})
export const projectOverrides = defineFixture({
  width: 640,
  render: () => (
    <RepositoryAgentDefaultsSection
      repo={{
        ...repo,
        agentLaunchDefaults: {
          defaultTuiAgent: 'codex',
          agentLaunchChoices: { codex: { model: 'gpt-5.4', options: { effort: 'high' } } }
        }
      }}
      updateRepo={() => {}}
    />
  )
})
