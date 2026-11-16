import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { SshTarget } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { RepositoryGitExecutionSection } from './RepositoryGitExecutionSection'

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/acme-web',
  displayName: 'acme-web',
  badgeColor: '',
  addedAt: 0,
  connectionId: 'sandbox'
}

function fixture(width: number, local = false) {
  const target: SshTarget = {
    id: 'sandbox',
    label: 'SBX',
    host: 'sandbox',
    port: 22,
    username: 'developer',
    gitExecution: 'remote',
    ...(local ? { gitExecutionProjects: { [repo.path]: 'local' as const } } : {})
  }
  return defineFixture({
    width,
    setup: () => {
      window.api.ssh.listTargets = async () => [target]
    },
    render: () => (
      <div className="p-4">
        <SettingsGroup title="Source control">
          <RepositoryGitExecutionSection repo={repo} forceVisible />
        </SettingsGroup>
      </div>
    )
  })
}

export const inherit = fixture(640)
export const thisComputer = fixture(640, true)
export const narrow = fixture(360, true)
