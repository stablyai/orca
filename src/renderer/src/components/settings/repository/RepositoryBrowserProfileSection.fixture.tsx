import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { BrowserSessionProfile } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RepositoryBrowserProfileSection } from './RepositoryBrowserProfileSection'

function profile(id: string, label: string, managed = false): BrowserSessionProfile {
  return {
    id,
    label,
    scope: id === 'default' ? 'default' : 'isolated',
    partition: `persist:${id}`,
    source: null,
    ...(managed ? { owner: { kind: 'repo' as const, id: 'other-repo' } } : {})
  }
}

function fixture(browserProfileId?: string) {
  const repo: Repo = {
    id: 'repo-1',
    path: '/repos/acme-web',
    displayName: 'acme-web',
    badgeColor: '#3b82f6',
    addedAt: 0,
    ...(browserProfileId ? { browserProfileId } : {})
  }
  return defineFixture({
    width: 560,
    store: {
      settings: { ...getDefaultSettings('/home/fixture'), browserProfileScope: 'repo' },
      browserSessionProfilesByHostId: {
        local: [
          profile('default', 'Default'),
          profile('work', 'Work'),
          profile('personal', 'Personal'),
          profile('managed', 'Repo: other-repo', true)
        ]
      },
      fetchBrowserSessionProfiles: async () => {}
    },
    render: () => <RepositoryBrowserProfileSection repo={repo} updateRepo={() => {}} />
  })
}

export const inherit = fixture()
export const picked = fixture('work')
export const deleted = fixture('gone')
