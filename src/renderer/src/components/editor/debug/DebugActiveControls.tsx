import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CornerDownRight,
  Pause,
  Play,
  SkipForward,
  Square
} from 'lucide-react'
import { Button } from '../../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { DebugCapabilities, DebugSessionInfo } from '@/store/debug/debug-session-types'

export function DebugActiveControls({
  sessionsList,
  activeSessionId,
  isStopped,
  capabilities,
  onSelectSession,
  onResume,
  onPause,
  onStepOver,
  onStepInto,
  onSmartStepInto,
  onStepOut,
  onStop
}: {
  sessionsList: DebugSessionInfo[]
  activeSessionId: number | null
  isStopped: boolean
  capabilities: DebugCapabilities | null
  onSelectSession: (id: number) => void
  onResume: () => void
  onPause: () => void
  onStepOver: () => void
  onStepInto: () => void
  onSmartStepInto: () => void
  onStepOut: () => void
  onStop: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-1">
      {sessionsList.length > 1 ? (
        <select
          aria-label={t('auto.components.editor.debug.sessionSelect', 'Debug Session')}
          value={activeSessionId ?? ''}
          onChange={(e) => onSelectSession(Number(e.target.value))}
          className="h-6 max-w-40 rounded border border-border/70 bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary"
        >
          {sessionsList.map((s) => (
            <option key={s.id} value={s.id}>
              {s.parent ? `↳ ${s.name}` : s.name}
            </option>
          ))}
        </select>
      ) : null}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        title={
          isStopped
            ? t('auto.components.editor.debug.continueTitle', 'Continue')
            : t('auto.components.editor.debug.pauseTitle', 'Pause')
        }
        onClick={isStopped ? onResume : onPause}
      >
        {isStopped ? (
          <Play className="size-3.5 text-status-success" />
        ) : (
          <Pause className="size-3.5 text-status-warning" />
        )}
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!isStopped}
        title={t('auto.components.editor.debug.stepOverTitle', 'Step Over')}
        onClick={onStepOver}
      >
        <SkipForward className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!isStopped}
        title={t('auto.components.editor.debug.stepIntoTitle', 'Step Into')}
        onClick={onStepInto}
      >
        <ArrowDownToLine className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!isStopped || !capabilities?.stepInTargets}
        title={t('auto.components.editor.debug.smartStepIntoTitle', 'Smart Step Into')}
        onClick={onSmartStepInto}
      >
        <CornerDownRight className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!isStopped}
        title={t('auto.components.editor.debug.stepOutTitle', 'Step Out')}
        onClick={onStepOut}
      >
        <ArrowUpFromLine className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        title={t('auto.components.editor.debug.stopTitle', 'Stop Debug')}
        onClick={onStop}
      >
        <Square className="size-3 fill-destructive text-destructive" />
      </Button>
    </div>
  )
}
