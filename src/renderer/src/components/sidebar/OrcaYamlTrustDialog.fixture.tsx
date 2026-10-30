import { defineFixture } from '../../component-fixtures/component-fixture'
import OrcaYamlTrustDialog from './OrcaYamlTrustDialog'

export const permanentRemoval = defineFixture({
  width: 680,
  store: {
    activeModal: 'confirm-orca-yaml-hooks',
    modalData: {
      repoId: 'example',
      repoName: 'Example project',
      workspaceName: 'API sandbox',
      workspacePath: '/workspaces/example/api-sandbox',
      scriptKind: 'remove',
      scriptContent: 'set -eu\n./scripts/remove-environment --project "$ORCA_WORKTREE_PATH"',
      contentHash: 'fixture',
      onResolve: () => {}
    }
  },
  render: () => (
    <div style={{ height: 680 }}>
      <OrcaYamlTrustDialog />
    </div>
  )
})
