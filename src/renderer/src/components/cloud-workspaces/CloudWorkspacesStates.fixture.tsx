import { defineFixture } from '../../component-fixtures/component-fixture'
import { EmptyState, ErrorState, SkeletonRows } from './CloudWorkspacesStates'
import { describeError } from './cloud-workspace-errors'

const WIDTH = 720

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-xl border border-border bg-card p-1">{children}</div>
}

/** Every empty state the list can show: team, mine, archived and filtered. */
export const empty = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="flex flex-col gap-3">
      <Card>
        <EmptyState scope="team" archived={false} filtered={false} />
      </Card>
      <Card>
        <EmptyState scope="mine" archived={false} filtered={false} />
      </Card>
      <Card>
        <EmptyState scope="team" archived filtered={false} />
      </Card>
      <Card>
        <EmptyState scope="team" archived={false} filtered />
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
        <ErrorState message={describeError('unavailable')} retrying={false} onRetry={() => {}} />
      </Card>
      <Card>
        <ErrorState
          message={describeError('entitlement_denied', 'concurrency_limit')}
          retrying
          onRetry={() => {}}
        />
      </Card>
      <Card>
        <ErrorState message={describeError('unauthorized')} retrying={false} onRetry={() => {}} />
      </Card>
    </div>
  )
})
