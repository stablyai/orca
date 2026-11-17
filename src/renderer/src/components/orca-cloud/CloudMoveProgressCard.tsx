// "Move to this computer" once it starts: the app's progress card (the one app updates use) in the
// notification stack. − minimizes it to the status bar (CloudMoveStatusSegment); the result comes
// back as the same card, which never takes focus or switches workspace on its own.
import React from 'react'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cancelOrcaCloudTransfer } from '@/lib/orca-cloud-transfer-flow'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  closeMoveToThisComputer,
  setMoveMinimized,
  useCloudMoveState,
  type CloudMoveState
} from '@/lib/orca-cloud/orca-cloud-move-store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  ProgressCard,
  ProgressCardHeader,
  useProgressCardExit
} from '../maintenance/progress-card/ProgressCard'
import { CloudMoveToComputerView } from './CloudMoveToComputerView'
import { cloudMoveReapplyFor, startCloudMove } from './CloudMoveToComputerDialog'
import { cloudMoveTitle } from './cloud-move-copy'

export type CloudMoveCardState = Extract<CloudMoveState, { stage: 'running' | 'done' | 'failed' }>

/** The card's body for one state (fixtures render it without the stores). */
export function CloudMoveProgressCardView({
  state,
  now,
  animationClass = '',
  onMinimize,
  onDismiss,
  onCancelMove,
  onRetry,
  onReapply,
  onOpenLocal,
  onOpenFolder
}: {
  state: CloudMoveCardState
  now: number
  animationClass?: string
  onMinimize: () => void
  onDismiss: () => void
  onCancelMove: () => void
  onRetry: () => void
  onReapply?: () => void
  onOpenLocal: (worktreeId: string) => void
  onOpenFolder: (dir: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const running = state.stage === 'running'
  const title = cloudMoveTitle(state, t)
  return (
    <ProgressCard
      ariaLabel={title}
      animationClass={animationClass}
      onEscape={running ? onMinimize : onDismiss}
    >
      <div className="flex flex-col gap-3 p-4">
        <ProgressCardHeader
          title={title}
          onMinimize={running ? onMinimize : undefined}
          onDismiss={running ? undefined : onDismiss}
        />
        <CloudMoveToComputerView
          state={state}
          now={now}
          onConfirm={onRetry}
          onCancelMove={onCancelMove}
          onClose={onDismiss}
          onOpenLocal={onOpenLocal}
          onOpenFolder={onOpenFolder}
          onReapply={onReapply}
        />
      </div>
    </ProgressCard>
  )
}

/** Mounted in the notification stack; renders the move while it runs and its result. */
export function CloudMoveProgressCard(): React.JSX.Element | null {
  const state = useCloudMoveState()
  const visible =
    (state.stage === 'running' || state.stage === 'done' || state.stage === 'failed') &&
    !state.minimized
  const now = useNow(1_000, visible && state.stage === 'running')
  const { animationClass, exit } = useProgressCardExit()
  if (!visible) {
    return null
  }
  return (
    <CloudMoveProgressCardView
      state={state}
      now={now}
      animationClass={animationClass}
      onMinimize={() => exit(() => setMoveMinimized(true))}
      onDismiss={() => exit(closeMoveToThisComputer)}
      onCancelMove={cancelOrcaCloudTransfer}
      onRetry={() => startCloudMove(state, 0)}
      onReapply={cloudMoveReapplyFor(state)}
      onOpenLocal={(worktreeId) => activateAndRevealWorktree(worktreeId)}
      onOpenFolder={(dir) => void window.api.shell.openPath(dir, LOCAL_EXECUTION_HOST_ID)}
    />
  )
}
