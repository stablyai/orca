import { defineFixture } from '../../component-fixtures/component-fixture'
import { WorktreeSetupSteps } from './WorktreeSetupSteps'
import { deriveWorktreeSetupSteps, type WorktreeSetupStep } from './worktree-setup-steps'

const T0 = 1_800_000_000_000
const NOW = T0 + 14_000

function frame(steps: WorktreeSetupStep[], error: string | null = null) {
  return defineFixture({
    width: 560,
    render: () => (
      <div className="native-chat-appearance bg-chat-canvas p-4">
        <WorktreeSetupSteps
          steps={steps}
          agentLabel="Claude Code"
          error={error}
          onRetry={() => {}}
          onDismiss={() => {}}
        />
      </div>
    )
  })
}

export const runningCheckout = frame(
  deriveWorktreeSetupSteps(
    {
      status: 'creating',
      phase: 'creating',
      indeterminate: false,
      startedAt: T0,
      phaseLog: [
        { phase: 'preparing', at: T0 },
        { phase: 'fetching', at: T0 + 1_200 },
        { phase: 'creating', at: T0 + 4_800 }
      ],
      checkoutProgress: { percent: 62, completed: 1_240, total: 2_000 }
    },
    NOW
  )
)

export const doneThroughCheckout = frame([
  { id: 'fetch', state: 'done', elapsedMs: 2_400, percent: null },
  { id: 'create', state: 'done', elapsedMs: 9_100, percent: null },
  { id: 'start-agent', state: 'pending', elapsedMs: null, percent: null }
])

export const failed = frame(
  deriveWorktreeSetupSteps(
    {
      status: 'error',
      phase: 'fetching',
      indeterminate: false,
      startedAt: T0,
      phaseLog: [{ phase: 'fetching', at: T0 }]
    },
    NOW
  ),
  "fatal: couldn't find remote ref feature/missing-base"
)

export const indeterminate = frame(
  deriveWorktreeSetupSteps(
    { status: 'creating', phase: 'creating', indeterminate: true, startedAt: T0 },
    NOW
  )
)
