import { useState } from 'react'
import { Button } from '../../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../../ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { normalizeDebugPathKey, useDebugSessionStore } from '@/store/debug/use-debug-session-store'

export function DebugBreakpointPopover({
  filePath,
  line,
  x,
  y,
  focusLog = false,
  onClose
}: {
  filePath: string
  line: number
  x: number
  y: number
  focusLog?: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const fileKey = normalizeDebugPathKey(filePath)
  const bp = useDebugSessionStore((s) => s.breakpointsByFile[fileKey]?.find((b) => b.line === line))
  const bpState = useDebugSessionStore((s) =>
    s.breakpointStatesByFile[fileKey]?.find((st) => st.line === line)
  )
  const status = useDebugSessionStore((s) => s.status)
  const updateBreakpoint = useDebugSessionStore((s) => s.updateBreakpoint)
  const removeBreakpoint = useDebugSessionStore((s) => s.removeBreakpoint)

  const [condition, setCondition] = useState(bp?.condition ?? '')
  const [hitCondition, setHitCondition] = useState(bp?.hitCondition ?? '')
  const [logMessage, setLogMessage] = useState(bp?.logMessage ?? '')

  if (!bp) {
    return null
  }

  const fileName = filePath.split(/[\\/]/).at(-1) || filePath
  const isActive = status === 'starting' || status === 'running' || status === 'stopped'

  const commitDraft = (): void => {
    void updateBreakpoint(filePath, line, {
      condition: condition.trim() || null,
      hitCondition: hitCondition.trim() || null,
      logMessage: logMessage.trim() || null
    })
  }

  const commitAndClose = (): void => {
    commitDraft()
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isImeOwnedKeyboardEvent(e)) {
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commitAndClose()
    }
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          commitAndClose()
        }
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          style={{ left: x, top: y }}
          className="pointer-events-none fixed size-px"
        />
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={6} className="w-80">
        <div className="space-y-2.5 p-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono font-medium text-foreground">
              {fileName}:{line}
            </span>
            {isActive && bpState ? (
              <span
                className={
                  bpState.verified
                    ? 'shrink-0 text-[10px] text-status-success'
                    : 'shrink-0 text-[10px] text-muted-foreground'
                }
                title={bpState.message ?? undefined}
              >
                {bpState.verified
                  ? t('auto.components.editor.debug.breakpointVerifiedLabel', 'Verified')
                  : t('auto.components.editor.debug.breakpointUnverifiedLabel', 'Unverified')}
              </span>
            ) : null}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={bp.enabled}
              onChange={(e) => void updateBreakpoint(filePath, line, { enabled: e.target.checked })}
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
              autoFocus={!focusLog}
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              onBlur={commitDraft}
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
              onBlur={commitDraft}
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
              autoFocus={focusLog}
              value={logMessage}
              onChange={(e) => setLogMessage(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={handleKeyDown}
              placeholder={t(
                'auto.components.editor.debug.breakpointLogMessagePlaceholder',
                'e.g. Value: {x}'
              )}
              className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
            />
          </label>

          <div className="flex items-center justify-end gap-1.5 pt-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                void removeBreakpoint(filePath, line)
                onClose()
              }}
            >
              {t('auto.components.editor.debug.removeAction', 'Remove')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={commitAndClose}>
              {t('auto.components.editor.debug.doneAction', 'Done')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
