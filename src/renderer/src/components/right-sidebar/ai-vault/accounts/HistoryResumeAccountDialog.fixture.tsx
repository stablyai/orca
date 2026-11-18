import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { HistoryResumeAccountDialog } from './HistoryResumeAccountDialog'

const accounts = [
  { id: null, label: 'System default · personal@example.com', available: true },
  { id: 'work', label: 'Work · work@example.com', available: true },
  { id: 'expired', label: 'Old account · old@example.com', available: false }
]
export const differentWorkspace = defineFixture({
  width: 620,
  render: () => (
    <div className="h-[600px] bg-background">
      <HistoryResumeAccountDialog
        plan={{
          token: 'fixture',
          accounts,
          lastAccountId: null,
          workspaceAccountId: 'work',
          needsChoice: true
        }}
        onSelect={() => {}}
      />
    </div>
  )
})
export const unknown = defineFixture({
  width: 360,
  render: () => (
    <div className="h-[640px] bg-background">
      <HistoryResumeAccountDialog
        plan={{ token: 'fixture', accounts, workspaceAccountId: 'work', needsChoice: true }}
        onSelect={() => {}}
      />
    </div>
  )
})
