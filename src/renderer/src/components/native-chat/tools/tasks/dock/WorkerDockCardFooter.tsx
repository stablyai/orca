import { useId } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'

/** What the chat's own untargeted stop ends, as its button names it. */
export type WorkerDockStopAllScope = 'all' | 'subagents-and-commands'

/** Stop all, for a provider that can only stop everything at once. It stops the chat's own
 *  subagents and commands, never orchestration workers, so with workers listed it says what it stops
 *  and that the workers keep running. */
function WorkerDockStopAll({
  stopAll,
  scope
}: {
  stopAll: { pending: boolean; onStop: () => void }
  scope: WorkerDockStopAllScope
}) {
  const t = useTranslate()
  const noteId = useId()
  const label =
    scope === 'subagents-and-commands'
      ? t(
          'components.native-chat.workerDock.stopSubagentsAndCommands',
          'Stop subagents and commands'
        )
      : t('components.native-chat.workerDock.stopAll', 'Stop all')
  const note =
    scope === 'all'
      ? null
      : t('components.native-chat.workerDock.workersKeepRunning', 'Workers keep running')
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        // Never cut: a long translation in a narrow pane wraps inside the button, right-aligned.
        className="h-auto min-h-6 min-w-0 shrink whitespace-normal text-right"
        title={note ?? undefined}
        aria-describedby={note ? noteId : undefined}
        aria-disabled={stopAll.pending}
        onClick={() => {
          if (!stopAll.pending) {
            stopAll.onStop()
          }
        }}
      >
        {stopAll.pending ? t('components.native-chat.workerDock.stopping', 'Stopping…') : label}
      </Button>
      {note ? (
        <span id={noteId} className="sr-only">
          {note}
        </span>
      ) : null}
    </>
  )
}

/** The panel's bulk actions, one right-aligned row in its footer, drawn only when they apply: Clear
 *  failed once two or more failures can be acknowledged, and the chat's own Stop all. The row never
 *  wraps: when both labels can't fit, only Stop shows (failed rows keep their own Clear). */
export function WorkerDockCardFooter({
  clearable,
  clearing,
  namesWorkers = false,
  onClearAll,
  stopAll,
  stopAllScope = 'all'
}: {
  clearable: number
  clearing: boolean
  /** A failed command is listed too, which Clear never removes: the button says it clears workers. */
  namesWorkers?: boolean
  onClearAll: () => void
  stopAll?: { pending: boolean; onStop: () => void }
  stopAllScope?: WorkerDockStopAllScope
}) {
  const t = useTranslate()
  const showClear = clearable >= 2
  const clearName = t(
    'components.native-chat.workerDock.clearAllLabel',
    'Clear all {{count}} failed workers',
    { count: clearable, defaultValue_one: 'Clear failed worker' }
  )
  if (!showClear && !stopAll) {
    return null
  }
  return (
    <div
      data-worker-dock-footer=""
      className="@container/dock-footer mt-1 flex flex-nowrap items-center justify-end gap-1 border-t border-border px-1 pt-1"
    >
      {showClear ? (
        <Button
          variant="ghost"
          size="xs"
          // Beside Stop in a footer too narrow for both labels, the bulk Clear steps aside: every
          // failed row it would clear has its own Clear, and Stop's label is never cut.
          // The width both labels need side by side: the longer Clear label needs more.
          className={
            !stopAll
              ? 'shrink-0'
              : namesWorkers
                ? 'hidden shrink-0 @min-[22rem]/dock-footer:inline-flex'
                : 'hidden shrink-0 @min-[18rem]/dock-footer:inline-flex'
          }
          aria-label={clearName}
          aria-disabled={clearing}
          onClick={() => {
            if (!clearing) {
              onClearAll()
            }
          }}
        >
          {namesWorkers
            ? t('components.native-chat.workerDock.clearFailedWorkers', 'Clear failed workers')
            : t('components.native-chat.workerDock.clearFailed', 'Clear failed')}
        </Button>
      ) : null}
      {stopAll ? <WorkerDockStopAll stopAll={stopAll} scope={stopAllScope} /> : null}
    </div>
  )
}
