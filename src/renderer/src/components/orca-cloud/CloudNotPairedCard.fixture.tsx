// A paired cloud workspace whose pairing is gone: the waking overlay's failure card offers
// "Open cloud workspace…" (it used to point at "Cloud workspaces on Home" in text).
import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWakingOverlay } from './CloudWakingOverlay'

const noop = (): void => {}

export const notPairedCard = defineFixture({
  width: 640,
  render: () => (
    <div className="relative h-[340px] overflow-hidden rounded-md border border-border bg-background">
      <CloudWakingOverlay
        wake={{
          workspaceId: 'ws',
          phase: 'failed',
          source: 'open',
          startedAt: Date.now(),
          at: Date.now(),
          message:
            'This workspace is no longer linked to this computer. Use Open cloud workspace… to link it again.',
          notPaired: true
        }}
        workspaceName="Refund webhooks"
        autoFocus={false}
        onRetry={noop}
        onRestart={noop}
        onDismiss={noop}
      />
    </div>
  )
})
