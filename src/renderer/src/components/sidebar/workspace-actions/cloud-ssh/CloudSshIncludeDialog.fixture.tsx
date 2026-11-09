import { defineFixture } from '../../../../component-fixtures/component-fixture'
import CloudSshIncludeDialog from './CloudSshIncludeDialog'

export const open = defineFixture({
  width: 640,
  store: {
    activeModal: 'confirm-cloud-ssh-include',
    modalData: {
      workspaceId: 'orca::/vercel/orca/workspaces/project/fix-login',
      editor: { id: 'builtin:cursor', label: 'Cursor', kind: 'cursor' },
      status: {
        cloud: true,
        hasAccess: true,
        asleep: false,
        alias: null,
        includeInstalled: false,
        editors: []
      },
      includeLine: 'Include "/Users/me/Library/Application Support/orca/cloud-ssh/config"'
    }
  },
  render: () => (
    <div className="h-[420px] bg-background">
      <CloudSshIncludeDialog />
    </div>
  )
})
