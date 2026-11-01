import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Repo } from '../../../../shared/repo-types'
import { RemoteFileBrowser } from './RemoteFileBrowser'

const TARGET_ID = 'build-box'
const HOME = '/home/alice'
const noop = (): void => {}

function sshRepo(id: string, path: string, addedAt: number): Repo {
  return {
    id,
    path,
    displayName: path.split('/').pop() ?? path,
    badgeColor: '#737373',
    addedAt,
    executionHostId: `ssh:${TARGET_ID}`
  }
}

const ACME = `${HOME}/src/github.com/acme`

function stubBrowseDir(): void {
  const listings: Record<string, string[]> = {
    [HOME]: ['.config', 'Downloads', 'notes', 'src'],
    [`${HOME}/src`]: ['github.com'],
    [`${HOME}/src/github.com`]: ['acme'],
    [ACME]: ['orca', 'orca-docs', 'website'],
    '/srv/apps': ['billing-api', 'status-page']
  }
  window.api.ssh.browseDir = async ({ dirPath }) => {
    const resolvedPath = dirPath === '~' ? HOME : dirPath
    return {
      resolvedPath,
      pathFlavor: 'posix',
      entries: (listings[resolvedPath] ?? []).map((name) => ({ name, isDirectory: true }))
    }
  }
}

export const projectFolders = defineFixture({
  width: 480,
  store: {
    repos: [
      sshRepo('orca', `${ACME}/orca`, 3),
      sshRepo('orca-docs', `${ACME}/orca-docs`, 2),
      sshRepo('billing', '/srv/apps/billing-api', 1)
    ]
  },
  setup: stubBrowseDir,
  render: () => <RemoteFileBrowser targetId={TARGET_ID} onSelect={noop} onCancel={noop} />
})
