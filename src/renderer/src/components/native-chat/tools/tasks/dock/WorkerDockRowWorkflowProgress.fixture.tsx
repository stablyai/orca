import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  NativeChatWorkerDockFrame,
  useWorkerDockStructuralValue
} from './NativeChatWorkerDockFrame'
import { WorkerDockRow, type WorkerDockRowView } from './WorkerDockRow'

// A Claude chat running a three-phase Workflow, now in its second phase.
const workflow: WorkerDockRowView = {
  id: 'home/source/workflow/review-changes',
  dispatchId: 'review-changes',
  source: 'source',
  kind: 'workflow',
  name: 'review-changes',
  title: 'Review changed files across dimensions, verify each finding',
  model: null,
  state: 'running',
  changedAt: Date.now() - 4 * 60_000,
  startedAt: Date.now() - 4 * 60_000,
  reason: null,
  settlement: null,
  resultId: null,
  stoppable: true,
  ownerActionsAvailable: true
}

function HeldRow({ row }: { row: WorkerDockRowView }): React.JSX.Element {
  return (
    <WorkerDockRow
      row={useWorkerDockStructuralValue(row)}
      mixed={false}
      visible
      pending={false}
      onOpen={() => {}}
      onAction={() => {}}
    />
  )
}

function Row({ row }: { row: WorkerDockRowView }): React.JSX.Element {
  return (
    <TooltipProvider>
      <div className="native-chat-appearance p-4">
        <NativeChatWorkerDockFrame>
          {/* The frame shows only while it holds a task list. */}
          <div data-native-chat-background-tasks="">
            <HeldRow row={row} />
          </div>
        </NativeChatWorkerDockFrame>
      </div>
    </TooltipProvider>
  )
}

/** A row with no phase progress: its accessible label is the title and state only. */
export const titleOnly = defineFixture({ width: 420, render: () => <Row row={workflow} /> })

/** A row whose accessible label also carries the phase line (current phase, its title, how many of
 *  that phase's agents finished or failed). The row looks the same; only the label differs. */
export const withProgress = defineFixture({
  width: 420,
  render: () => (
    <Row row={{ ...workflow, progress: 'Phase 2/3 · Verify · 4/10 agents done, 1 failed' }} />
  )
})
