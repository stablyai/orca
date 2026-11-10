// Waking in type-through mode: the terminal stays visible and typeable under a small pill.
// (A sibling of OrcaCloudWorkspace.fixture.tsx, which is at its size limit.)
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { CloudWakingOverlay } from './CloudWakingOverlay'

const noop = (): void => {}

const wake = (over: Partial<CloudWakeProgressEvent> = {}): CloudWakeProgressEvent => ({
  workspaceId: 'ws',
  phase: 'waking',
  source: 'open',
  startedAt: Date.now() - 3_200,
  at: Date.now(),
  ...over
})

function Pane({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="relative h-[340px] overflow-hidden rounded-md border border-border bg-background">
      {children}
    </div>
  )
}

// Started `ms` before render (not module load), so the pill reads its exact elapsed time.
const startedAgo = (
  ms: number,
  over: Partial<CloudWakeProgressEvent> = {}
): CloudWakeProgressEvent => wake({ startedAt: Date.now() - ms, at: Date.now(), ...over })

// Type-through: the terminal stays visible and typeable under a small pill.
function TypeThrough({
  value,
  pendingInput = 0
}: {
  value: CloudWakeProgressEvent
  pendingInput?: number
}): React.JSX.Element {
  return (
    <Pane>
      <div className="absolute inset-0 px-4 py-3 font-mono text-xs text-foreground">
        <div className="text-muted-foreground">Last login: Mon Nov 9 20:41 on ttys004</div>
        <div>
          <span className="text-muted-foreground">~/fix-auth-redirect $</span> git status
        </div>
      </div>
      <CloudWakingOverlay
        wake={value}
        workspaceName="fix-auth-redirect"
        autoFocus={false}
        typeThrough
        pendingInput={pendingInput}
        onClearPending={noop}
        onRetry={noop}
        onRestart={noop}
        onDismiss={noop}
      />
    </Pane>
  )
}

export const wakingTypeThrough = defineFixture({
  width: 640,
  render: () => <TypeThrough value={startedAgo(3_200)} />
})

export const wakingTypeThroughPending = defineFixture({
  width: 640,
  render: () => <TypeThrough value={startedAgo(3_200)} pendingInput={12} />
})

export const wakingTypeThroughSlow = defineFixture({
  width: 640,
  render: () => <TypeThrough value={startedAgo(12_000)} pendingInput={12} />
})

// The sandbox is up and the pane in front is re-attaching: the clock still counts from the start.
export const wakingConnecting = defineFixture({
  width: 640,
  render: () => <TypeThrough value={startedAgo(6_000, { phase: 'connecting' })} />
})

// Woken on intent (hover) 3 s before the click: the pill opens already counting.
export const wakingFromPredictive = defineFixture({
  width: 640,
  render: () => <TypeThrough value={startedAgo(3_000)} />
})

// The sandbox woke but the pane in front never took input within the cap: a reconnect card,
// never a silent dead pane.
export const wakingTerminalStalled = defineFixture({
  width: 640,
  render: () => (
    <Pane>
      <CloudWakingOverlay
        wake={startedAgo(26_000, { phase: 'failed' })}
        workspaceName="fix-auth-redirect"
        autoFocus={false}
        typeThrough
        terminalStalled
        onRetry={noop}
        onRestart={noop}
        onDismiss={noop}
      />
    </Pane>
  )
})
