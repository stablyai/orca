import type React from 'react'
import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Pause,
  Play,
  RotateCcw,
  Square,
  StepForward,
  type LucideIcon
} from 'lucide-react'
import type { DebugSnapshot, DebugStatus, DebugWorktree } from '../../../../preload/api/debug-api'
import type { DebugClient, DebugClientResult } from '@/lib/debug/debug-client'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const LIVE_STATUSES: readonly DebugStatus[] = ['starting', 'running', 'stopped']

export function isDebugSessionLive(snapshot: DebugSnapshot | null): boolean {
  return snapshot !== null && LIVE_STATUSES.includes(snapshot.status)
}

type ToolbarClient = Pick<
  DebugClient,
  'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut' | 'restart' | 'stop'
>

type DebugToolbarProps = {
  client: ToolbarClient
  target: DebugWorktree
  snapshot: DebugSnapshot
  /** The thread the user picked in the call stack; falls back to the stopped one. */
  selectedThreadId: number | null
  onSnapshot: (snapshot: DebugSnapshot) => void
  onRefusal: (message: string | null) => void
}

type ToolbarButton = {
  key: string
  icon: LucideIcon
  label: string
  shortcut: string
  disabled: boolean
  run: () => Promise<DebugClientResult<unknown>>
}

function shortcutLabel(key: string, modifiers: { shift?: boolean; mod?: boolean } = {}): string {
  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
  if (isMac) {
    return `${modifiers.mod ? '⌘' : ''}${modifiers.shift ? '⇧' : ''}${key}`
  }
  return `${modifiers.mod ? 'Ctrl+' : ''}${modifiers.shift ? 'Shift+' : ''}${key}`
}

export function DebugToolbar({
  client,
  target,
  snapshot,
  selectedThreadId,
  onSnapshot,
  onRefusal
}: DebugToolbarProps): React.JSX.Element {
  const live = isDebugSessionLive(snapshot)
  const paused = snapshot.status === 'stopped' && snapshot.stopped !== null
  const stoppedThread = selectedThreadId ?? snapshot.stopped?.threadId ?? null
  // Pause needs a thread to name; DAP adapters accept any live one.
  const runningThread = snapshot.threads[0]?.id ?? null
  const stepTarget = stoppedThread === null ? null : { ...target, threadId: stoppedThread }

  // One action at a time: a second step or restart before the first answers would race it.
  const [pending, setPending] = useState<string | null>(null)
  const act = async (key: string, run: () => Promise<DebugClientResult<unknown>>) => {
    setPending(key)
    try {
      const result = await run()
      if (!result.ok) {
        onRefusal(result.message)
        return
      }
      onRefusal(null)
      if (isSnapshot(result.value)) {
        onSnapshot(result.value)
      }
    } catch (error) {
      onRefusal(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }

  const step = (
    call: 'continue' | 'next' | 'stepIn' | 'stepOut'
  ): (() => Promise<DebugClientResult<unknown>>) => {
    return () => (stepTarget ? client[call](stepTarget) : Promise.resolve(noThread()))
  }

  const buttons: ToolbarButton[] = [
    paused
      ? {
          key: 'continue',
          icon: Play,
          label: translate('debug.toolbar.continue', 'Continue'),
          shortcut: shortcutLabel('F5'),
          disabled: stepTarget === null,
          run: step('continue')
        }
      : {
          key: 'pause',
          icon: Pause,
          label: translate('debug.toolbar.pause', 'Pause'),
          shortcut: shortcutLabel('F6'),
          disabled: snapshot.status !== 'running' || runningThread === null,
          run: () =>
            runningThread === null
              ? Promise.resolve(noThread())
              : client.pause({ ...target, threadId: runningThread })
        },
    {
      key: 'step-over',
      icon: StepForward,
      label: translate('debug.toolbar.stepOver', 'Step Over'),
      shortcut: shortcutLabel('F10'),
      disabled: !paused || stepTarget === null,
      run: step('next')
    },
    {
      key: 'step-into',
      icon: ArrowDownToLine,
      label: translate('debug.toolbar.stepInto', 'Step Into'),
      shortcut: shortcutLabel('F11'),
      disabled: !paused || stepTarget === null,
      run: step('stepIn')
    },
    {
      key: 'step-out',
      icon: ArrowUpFromLine,
      label: translate('debug.toolbar.stepOut', 'Step Out'),
      shortcut: shortcutLabel('F11', { shift: true }),
      disabled: !paused || stepTarget === null,
      run: step('stepOut')
    },
    {
      key: 'restart',
      icon: RotateCcw,
      label: translate('debug.toolbar.restart', 'Restart'),
      shortcut: shortcutLabel('F5', { shift: true, mod: true }),
      disabled: !live || snapshot.status === 'starting',
      run: () => client.restart(target)
    },
    {
      key: 'stop',
      icon: Square,
      label: translate('debug.toolbar.stop', 'Stop'),
      shortcut: shortcutLabel('F5', { shift: true }),
      disabled: !live,
      run: () => client.stop(target)
    }
  ]

  return (
    <div
      role="toolbar"
      aria-label={translate('debug.toolbar.label', 'Debug controls')}
      className="flex items-center gap-0.5 border-b border-border px-2 py-1"
    >
      {buttons.map((button) => (
        <Button
          key={button.key}
          variant="ghost"
          size="icon-xs"
          aria-label={button.label}
          title={`${button.label} (${button.shortcut})`}
          // Stop always stays available, so a hung request can still be ended.
          disabled={button.disabled || (pending !== null && button.key !== 'stop')}
          aria-busy={pending === button.key}
          onClick={() => void act(button.key, button.run)}
        >
          <button.icon />
        </Button>
      ))}
    </div>
  )
}

function noThread(): DebugClientResult<null> {
  return {
    ok: false,
    reason: 'no-session',
    message: translate('debug.toolbar.noThread', 'No thread to act on.')
  }
}

function isSnapshot(value: unknown): value is DebugSnapshot {
  return typeof value === 'object' && value !== null && 'status' in value && 'seq' in value
}
