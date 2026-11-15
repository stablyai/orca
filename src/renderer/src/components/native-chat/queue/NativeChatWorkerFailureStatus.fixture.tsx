import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentSessionHeldDelivery } from '../../../../../shared/agent-session/agent-session-held-delivery'
import { NativeChatWorkerFailureStatus } from './NativeChatWorkerFailureStatus'

const base: AgentSessionHeldDelivery = {
  delivered: false,
  state: 'held',
  reason: { kind: 'worker_failed', failure: 'network' },
  failureId: 'fd92f3cc623e58c45258438c92236d891ec848c39030ce59a568c72768129fa09',
  target: { sessionId: 'fixture-worker', dispatchId: 'fixture-dispatch' },
  provider: 'claude',
  waiting: 2
}

function row(extra: Partial<AgentSessionHeldDelivery>, sender = false) {
  return defineFixture({
    width: 680,
    render: () => (
      <div className="native-chat-appearance bg-background p-3">
        <NativeChatWorkerFailureStatus
          delivery={{ ...base, ...extra }}
          workerName="Build worker"
          pending={false}
          onResume={() => undefined}
          onSignIn={() => undefined}
          onOpenWorker={sender ? () => undefined : undefined}
        />
      </div>
    )
  })
}

export const network = row({})
export const provider = row({ reason: { kind: 'worker_failed', failure: 'provider' } })
export const signedOut = row({ reason: { kind: 'worker_failed', failure: 'sign-in' } })
export const usageLimit = row({
  reason: { kind: 'worker_failed', failure: 'usage-limit' },
  resetsAt: Date.now() + 3_600_000
})
export const usageReady = row({
  reason: { kind: 'worker_failed', failure: 'usage-limit' },
  resetsAt: Date.now() - 60_000
})
export const unknown = row({ reason: { kind: 'worker_failed', failure: 'unknown' } })
export const failedAgain = row({ recoveryUsed: true })
export const oneWaiting = row({ waiting: 1 })
export const noneWaiting = row({ waiting: 0 })

export const senderNetwork = row({}, true)
export const senderSignIn = row({ reason: { kind: 'worker_failed', failure: 'sign-in' } }, true)
export const senderUsage = row({ reason: { kind: 'worker_failed', failure: 'usage-limit' } }, true)
