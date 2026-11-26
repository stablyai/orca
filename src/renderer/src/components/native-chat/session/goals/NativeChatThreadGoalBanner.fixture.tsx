import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatThreadGoalBanner } from './NativeChatThreadGoalBanner'
import { NativeChatGoalCheckNotice } from '../../messages/notices/NativeChatGoalCheckNotice'

function goalFeedback(width: number, expanded: boolean) {
  return defineFixture({
    width,
    render: () => (
      <div className="native-chat-appearance bg-background py-3">
        <NativeChatThreadGoalBanner
          goal={{
            objective: 'Finish the delegated task and verify the worker’s result',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 120,
            createdAt: 0,
            updatedAt: 0,
            checks: 8,
            lastCheck:
              'Not satisfied: the worker has not reported yet. Wait for its report before verifying the result.'
          }}
          pending={false}
          hostChanges={false}
          sendUnavailable={false}
          isVisible={false}
          runningTurn={null}
          onChange={() => {}}
        />
        <div className="mx-5 mt-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
          Ask anything, @ to mention files, / for commands
        </div>
      </div>
    ),
    ...(expanded
      ? {
          interact: (frame: HTMLElement) => {
            frame.querySelector<HTMLButtonElement>('button[aria-label="Show full goal"]')?.click()
          }
        }
      : {})
  })
}

export const collapsed = goalFeedback(720, false)
export const expanded = goalFeedback(720, true)
export const narrowCollapsed = goalFeedback(360, false)
export const narrowExpanded = goalFeedback(360, true)

function piGoal(status: 'active' | 'paused' | 'blocked' | null) {
  const observedAt = Date.now()
  return defineFixture({
    width: 720,
    render: () => (
      <div className="native-chat-appearance bg-background py-3">
        {status && (
          <NativeChatThreadGoalBanner
            goal={{
              objective: 'Verify the release checklist',
              status,
              ...(status === 'blocked'
                ? { statusDetail: 'Waiting for the test owner to confirm the result.' }
                : {}),
              tokenBudget: null,
              tokensUsed: 120,
              timeUsedSeconds: 2,
              createdAt: observedAt - 2000,
              updatedAt: observedAt
            }}
            pending={false}
            hostChanges={false}
            agentPauses
            agentResumes
            sendUnavailable={status === 'active'}
            isVisible={false}
            runningTurn={status === 'active' ? { startedAt: observedAt } : null}
            onChange={() => {}}
          />
        )}
        <div className="mx-5 mt-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
          Ask anything, @ to mention files, / for commands
        </div>
      </div>
    ),
    ...(status === 'blocked'
      ? {
          interact: (frame: HTMLElement) => {
            frame.querySelector<HTMLButtonElement>('button[aria-label="Show full goal"]')?.click()
          }
        }
      : {})
  })
}

export const piBeforeGoalReport = piGoal(null)
export const piGoalActive = piGoal('active')
export const piGoalPaused = piGoal('paused')
export const piGoalBlocked = piGoal('blocked')

export const endedGoalChecks = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance bg-background p-3">
      <NativeChatGoalCheckNotice text={'2\nNot satisfied: the verification is still pending.'} />
    </div>
  ),
  interact: (frame: HTMLElement) => frame.querySelector<HTMLElement>('summary')?.click()
})
