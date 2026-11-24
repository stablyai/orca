import { useState } from 'react'
import { Button } from '../../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import {
  navigateToSourceLocation,
  normalizeDebugPathKey,
  useDebugSessionStore,
  type DebugBreakpoint,
  type DebugFunctionBreakpoint
} from '@/store/debug/use-debug-session-store'

export function LineBreakpointDetailEditor({
  filePath,
  bp,
  onCloseDialog
}: {
  filePath: string
  bp: DebugBreakpoint
  onCloseDialog: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const status = useDebugSessionStore((s) => s.status)
  const bpState = useDebugSessionStore((s) =>
    s.breakpointStatesByFile[normalizeDebugPathKey(filePath)]?.find((st) => st.line === bp.line)
  )
  const updateBreakpoint = useDebugSessionStore((s) => s.updateBreakpoint)
  const removeBreakpoint = useDebugSessionStore((s) => s.removeBreakpoint)

  const [condition, setCondition] = useState(bp.condition ?? '')
  const [hitCondition, setHitCondition] = useState(bp.hitCondition ?? '')
  const [logMessage, setLogMessage] = useState(bp.logMessage ?? '')

  const fileName = filePath.split(/[\\/]/).at(-1) || filePath
  const isActive = status === 'starting' || status === 'running' || status === 'stopped'

  const commit = (): void => {
    void updateBreakpoint(filePath, bp.line, {
      condition: condition.trim() || null,
      hitCondition: hitCondition.trim() || null,
      logMessage: logMessage.trim() || null
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!isImeOwnedKeyboardEvent(e) && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commit()
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="min-w-0">
          <div className="truncate font-mono font-medium text-foreground">
            {fileName}:{bp.line}
          </div>
          <div className="truncate text-[10px] text-muted-foreground" title={filePath}>
            {filePath}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              navigateToSourceLocation(filePath, bp.line, 1)
              onCloseDialog()
            }}
          >
            {t('auto.components.editor.debug.goToSourceAction', 'Go to Source')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void removeBreakpoint(filePath, bp.line)}
          >
            {t('auto.components.editor.debug.removeAction', 'Remove')}
          </Button>
        </div>
      </div>

      {isActive && bpState ? (
        <div
          className={
            bpState.verified
              ? 'text-[11px] text-status-success'
              : 'text-[11px] text-muted-foreground'
          }
        >
          {bpState.verified
            ? t('auto.components.editor.debug.breakpointVerifiedLabel', 'Verified')
            : (bpState.message ??
              t('auto.components.editor.debug.breakpointUnverifiedLabel', 'Unverified'))}
        </div>
      ) : null}

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={bp.enabled}
          onChange={(e) => void updateBreakpoint(filePath, bp.line, { enabled: e.target.checked })}
          className="size-3.5"
        />
        <span>{t('auto.components.editor.debug.breakpointEnabledLabel', 'Enabled')}</span>
      </label>

      <label className="block space-y-1">
        <span className="block text-[11px] text-muted-foreground">
          {t('auto.components.editor.debug.breakpointConditionLabel', 'Condition')}
        </span>
        <input
          type="text"
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          placeholder={t(
            'auto.components.editor.debug.breakpointConditionPlaceholder',
            'e.g. count > 10'
          )}
          className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
      </label>

      <label className="block space-y-1">
        <span className="block text-[11px] text-muted-foreground">
          {t('auto.components.editor.debug.breakpointHitCountLabel', 'Hit Count')}
        </span>
        <input
          type="text"
          value={hitCondition}
          onChange={(e) => setHitCondition(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          placeholder={t(
            'auto.components.editor.debug.breakpointHitCountPlaceholder',
            'e.g. 5 or >= 3'
          )}
          className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
      </label>

      <label className="block space-y-1">
        <span className="block text-[11px] text-muted-foreground">
          {t('auto.components.editor.debug.breakpointLogMessageLabel', 'Log Message')}
        </span>
        <input
          type="text"
          value={logMessage}
          onChange={(e) => setLogMessage(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          placeholder={t(
            'auto.components.editor.debug.breakpointLogMessagePlaceholder',
            'e.g. Value: {x}'
          )}
          className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
      </label>
    </div>
  )
}

export function FunctionBreakpointDetailEditor({
  index,
  bp
}: {
  index: number
  bp: DebugFunctionBreakpoint
}): React.JSX.Element {
  const t = useTranslate()
  const updateFunctionBreakpoint = useDebugSessionStore((s) => s.updateFunctionBreakpoint)
  const removeFunctionBreakpoint = useDebugSessionStore((s) => s.removeFunctionBreakpoint)

  const [name, setName] = useState(bp.name)
  const [condition, setCondition] = useState(bp.condition ?? '')
  const [hitCondition, setHitCondition] = useState(bp.hitCondition ?? '')

  const commit = (): void => {
    const nextName = name.trim() || bp.name
    void updateFunctionBreakpoint(index, {
      name: nextName,
      condition: condition.trim() || null,
      hitCondition: hitCondition.trim() || null
    })
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <span className="truncate font-mono font-medium text-foreground">{bp.name}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => void removeFunctionBreakpoint(index)}
        >
          {t('auto.components.editor.debug.removeAction', 'Remove')}
        </Button>
      </div>

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={bp.enabled}
          onChange={(e) => void updateFunctionBreakpoint(index, { enabled: e.target.checked })}
          className="size-3.5"
        />
        <span>{t('auto.components.editor.debug.breakpointEnabledLabel', 'Enabled')}</span>
      </label>

      <label className="block space-y-1">
        <span className="block text-[11px] text-muted-foreground">
          {t('auto.components.editor.debug.functionBreakpointLabel', 'Function')}
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          placeholder={t(
            'auto.components.editor.debug.functionBreakpointPlaceholder',
            'Function or symbol name'
          )}
          className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
      </label>

      <label className="block space-y-1">
        <span className="block text-[11px] text-muted-foreground">
          {t('auto.components.editor.debug.breakpointConditionLabel', 'Condition')}
        </span>
        <input
          type="text"
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          onBlur={commit}
          placeholder={t(
            'auto.components.editor.debug.breakpointConditionPlaceholder',
            'e.g. count > 10'
          )}
          className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
      </label>

      <label className="block space-y-1">
        <span className="block text-[11px] text-muted-foreground">
          {t('auto.components.editor.debug.breakpointHitCountLabel', 'Hit Count')}
        </span>
        <input
          type="text"
          value={hitCondition}
          onChange={(e) => setHitCondition(e.target.value)}
          onBlur={commit}
          placeholder={t(
            'auto.components.editor.debug.breakpointHitCountPlaceholder',
            'e.g. 5 or >= 3'
          )}
          className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
      </label>
    </div>
  )
}
