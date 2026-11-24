import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { ExecutionHostVmState } from '../../../../../../shared/execution-host/execution-host-health'
import {
  getVmStateLabel,
  VmStateTooltipBody,
  WorktreeCardVmStateBadge
} from './WorktreeCardVmStateBadge'

const states: ExecutionHostVmState[] = [
  'provisioning',
  'suspended',
  'waking',
  'resume_failed',
  'provision_failed'
]

export const allStates = defineFixture({
  width: 260,
  render: () => (
    <div className="flex flex-col gap-1 bg-sidebar p-2 text-[12px] text-foreground">
      {states.map((state) => (
        <div key={state} className="flex h-7 items-center gap-2 rounded-md px-1">
          <WorktreeCardVmStateBadge state={state} />
          <span className={state === 'suspended' ? 'text-muted-foreground' : ''}>
            {getVmStateLabel(state)}
          </span>
        </div>
      ))}
    </div>
  )
})

/** Tooltip copy per state; Resume failed carries its catalogued reason. */
export const tooltipBodies = defineFixture({
  width: 260,
  render: () => (
    <div className="flex flex-col gap-2 bg-sidebar p-2 text-[12px] text-foreground">
      {states.map((state) => (
        <div key={state} className="max-w-[220px] rounded-md border bg-popover px-3 py-1.5 text-xs">
          <VmStateTooltipBody
            state={state}
            failure={
              state === 'resume_failed'
                ? {
                    error: 'Resume exited with code 3.',
                    errorCode: 'resumeExited',
                    errorParams: { exitCode: 3 }
                  }
                : state === 'provision_failed'
                  ? {
                      error: 'Provisioning was interrupted.',
                      errorCode: 'provisionInterrupted'
                    }
                  : null
            }
          />
        </div>
      ))}
    </div>
  )
})
