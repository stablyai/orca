import { defineFixture } from '../../component-fixtures/component-fixture'
import { ErrorState, PickerEmptyState, SkeletonRows } from './CloudWorkspacesStates'

const WIDTH = 720

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-xl border border-border bg-card p-1">{children}</div>
}

/** Every empty state "Open cloud workspace…" can show. */
export const empty = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="flex flex-col gap-3">
      <Card>
        <PickerEmptyState reason={{ kind: 'none' }} onCreate={() => {}} />
      </Card>
      <Card>
        <PickerEmptyState reason={{ kind: 'all-in-sidebar' }} />
      </Card>
      <Card>
        <PickerEmptyState reason={{ kind: 'search' }} />
      </Card>
      <Card>
        <PickerEmptyState reason={{ kind: 'archived' }} />
      </Card>
      <Card>
        <PickerEmptyState reason={{ kind: 'none-running' }} />
      </Card>
      <Card>
        <PickerEmptyState reason={{ kind: 'teammate', name: 'Grace Hopper' }} />
      </Card>
    </div>
  )
})

export const loading = defineFixture({
  width: WIDTH,
  render: () => (
    <Card>
      <SkeletonRows />
    </Card>
  )
})

/** Error copy per control-plane code, idle and while a retry is reading. */
export const errors = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="flex flex-col gap-3">
      <Card>
        <ErrorState error="unavailable" retrying={false} onRetry={() => {}} onSignIn={() => {}} />
      </Card>
      <Card>
        <ErrorState
          error="entitlement_denied"
          reason="concurrency_limit"
          onSignIn={() => {}}
          retrying
          onRetry={() => {}}
        />
      </Card>
      <Card>
        <ErrorState error="unauthorized" retrying={false} onRetry={() => {}} onSignIn={() => {}} />
      </Card>
    </div>
  )
})
