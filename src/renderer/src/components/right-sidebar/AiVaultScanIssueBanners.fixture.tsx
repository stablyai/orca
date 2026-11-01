import { defineFixture } from '../../component-fixtures/component-fixture'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'

const scanResult: AiVaultListResult = {
  sessions: [],
  scannedAt: '2026-11-01T00:00:00Z',
  issues: [
    {
      executionHostId: 'local',
      agent: 'codex',
      kind: 'notice',
      path: '/sessions/rollout.jsonl',
      message:
        'Skipped 2 oversized transcript records over the 10.0 MiB limit (10.0 MiB at byte 1248001757, 10.0 MiB at byte 1265061030). The rest of the session was read.'
    }
  ]
}
export const compact = defineFixture({
  width: 320,
  render: () => (
    <div className="flex h-96 flex-col bg-sidebar text-sidebar-foreground">
      <h2 className="px-3 py-3 text-sm font-medium">Projects</h2>
      <AiVaultScanIssueBanners scanResult={scanResult} />
      <div className="space-y-4 p-3 text-sm">
        <div>Orca</div>
        <div>Mobile navigation</div>
        <div>Release planning</div>
      </div>
    </div>
  )
})
export const details = defineFixture({
  ...compact,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
  }
})
