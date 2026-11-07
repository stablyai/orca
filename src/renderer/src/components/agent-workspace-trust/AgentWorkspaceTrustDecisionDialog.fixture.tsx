import { Dialog } from '@/components/ui/dialog'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { AgentWorkspaceTrustDecisionDialogView } from './AgentWorkspaceTrustDecisionDialog'

export const firstLaunch = defineFixture({
  width: 640,
  render: () => (
    <Dialog open>
      <AgentWorkspaceTrustDecisionDialogView
        repoName="acme-web"
        saving={false}
        onAnswer={() => {}}
      />
    </Dialog>
  )
})
