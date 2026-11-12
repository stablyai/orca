import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { RepositoryHooksSection } from './RepositoryHooksSection'

const repo = {
  id: 'fixture-repo',
  path: '/Users/dev/orca',
  displayName: 'orca',
  badgeColor: '#737373',
  addedAt: 0,
  kind: 'git' as const,
  hookSettings: {
    mode: 'auto' as const,
    scripts: {
      setup: 'installer="$HOME/install-skills.sh"\n"$installer" "$ORCA_WORKTREE_PATH"',
      archive: ''
    }
  }
}

export const sharedAndLocal = defineFixture({
  width: 760,
  render: () => (
    <RepositoryHooksSection
      repo={repo}
      yamlHooks={{
        scripts: { setup: 'node config/scripts/run-internal-dev-setup.mjs\npnpm install' }
      }}
      hasHooksFile
      hooksInspectionReady
      mayNeedUpdate={false}
      copiedTemplate={false}
      forceVisible
      onCopyTemplate={() => {}}
      onUpdateHookSettings={() => {}}
    />
  )
})

export const localScriptsIgnored = defineFixture({
  width: 760,
  render: () => (
    <RepositoryHooksSection
      repo={{
        ...repo,
        hookSettings: { ...repo.hookSettings, commandSourcePolicy: 'shared-only' as const }
      }}
      yamlHooks={{ scripts: { setup: 'pnpm install' } }}
      hasHooksFile
      hooksInspectionReady
      mayNeedUpdate={false}
      copiedTemplate={false}
      forceVisible
      onCopyTemplate={() => {}}
      onUpdateHookSettings={() => {}}
    />
  )
})
