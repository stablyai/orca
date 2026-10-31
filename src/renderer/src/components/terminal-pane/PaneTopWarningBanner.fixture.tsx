import { Button } from '@/components/ui/button'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'

// Mocks for the temporary-worker strip; copy is the owner's, the countdown is frozen at 1:42.
function WorkerPane({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="pane relative h-24 bg-background">
      <PaneTopWarningBanner
        tone="neutral"
        title={title}
        primaryAction={
          <Button type="button" variant="outline" size="xs">
            Keep open
          </Button>
        }
      />
    </div>
  )
}

const running = 'Temporary orchestration worker · Closes 2 minutes after it finishes'
const finished = 'Temporary orchestration worker finished · Closes in 1:42'

export const workerRunning = defineFixture({
  width: 960,
  render: () => <WorkerPane title={running} />
})
export const workerFinished = defineFixture({
  width: 960,
  render: () => <WorkerPane title={finished} />
})
export const workerFinishedNarrow = defineFixture({
  width: 360,
  render: () => <WorkerPane title={finished} />
})
