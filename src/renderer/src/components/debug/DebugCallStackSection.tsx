import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DebugSessionStore } from '@/lib/debug/use-debug-session'
import type { DebugStackFrameWire } from '../../../../preload/api/debug-api'
import type { DebugRevealSource, DebugSectionProps } from './debug-section-contract'

type DebugCallStackSectionProps = DebugSectionProps & {
  store: DebugSessionStore
  reveal: DebugRevealSource
}

function frameLocation(frame: DebugStackFrameWire): string | null {
  const name = frame.source?.name ?? frame.source?.path?.split(/[\\/]/).at(-1)
  return name ? `${name}:${frame.line}` : null
}

export default function DebugCallStackSection({
  target,
  session,
  store,
  reveal
}: DebugCallStackSectionProps): React.JSX.Element {
  const { snapshot, selectedThreadId, selectedFrameId, frames } = session
  const threads = snapshot?.threads ?? []
  const stopped = snapshot?.stopped ?? null

  if (threads.length === 0) {
    return (
      <div className="px-3 py-1 text-muted-foreground">
        {translate('debug.callStack.empty', 'No threads')}
      </div>
    )
  }

  const selectFrame = (frame: DebugStackFrameWire): void => {
    const path = frame.source?.path
    if (!path) {
      return
    }
    store.selectFrame(target.worktreePath, frame.id)
    reveal(path, frame.line, frame.column)
  }

  return (
    <ul aria-label={translate('debug.callStack.title', 'Call Stack')}>
      {threads.map((thread) => {
        const open = thread.id === selectedThreadId
        return (
          <li key={thread.id}>
            <button
              type="button"
              aria-expanded={open}
              className="flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-accent"
              onClick={() => store.selectThread(target.worktreePath, thread.id)}
            >
              <ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} />
              <span className="truncate">{thread.name}</span>
              {stopped?.threadId === thread.id ? (
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {translate('debug.callStack.pausedOn', 'Paused on {{reason}}', {
                    reason: stopped.reason
                  })}
                </span>
              ) : null}
            </button>
            {open ? (
              <ul>
                {frames.length === 0 && stopped?.threadId === thread.id ? (
                  <li className="py-0.5 pl-7 pr-2 text-muted-foreground">
                    {translate('debug.callStack.loading', 'Loading…')}
                  </li>
                ) : null}
                {frames.map((frame) => {
                  const location = frameLocation(frame)
                  const current = frame.id === selectedFrameId
                  return (
                    <li key={frame.id}>
                      <button
                        type="button"
                        aria-current={current || undefined}
                        data-current={current || undefined}
                        disabled={!frame.source?.path}
                        className={cn(
                          'flex w-full items-center gap-2 py-0.5 pl-7 pr-2 text-left',
                          current ? 'bg-accent text-accent-foreground' : 'hover:bg-accent',
                          !frame.source?.path && 'cursor-default text-muted-foreground opacity-60'
                        )}
                        onClick={() => selectFrame(frame)}
                      >
                        <span className="truncate">{frame.name}</span>
                        {location ? (
                          <span
                            className="ml-auto shrink-0 font-mono text-muted-foreground"
                            title={frame.source?.path}
                          >
                            {location}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
