import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Send, X } from 'lucide-react'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { isScreenSubmitShortcut, getScreenSubmitShortcutLabel } from '@/lib/screen-submit-shortcut'

export type TerminalDraftPhase = 'loading' | 'editing' | 'locked' | 'unsupported' | 'conflict'

export function TerminalDraftPanel({
  phase,
  status,
  text,
  dirty,
  busy,
  actionsLocked,
  holder,
  reason,
  onTextChange,
  onReload,
  onSave,
  onSubmit,
  onClose,
  onTakeOver,
  onUseTerminalVersion,
  onKeepMine
}: {
  phase: TerminalDraftPhase
  status: string
  text: string
  dirty: boolean
  busy: boolean
  actionsLocked: boolean
  holder: string | null
  reason: string
  onTextChange: (text: string) => void
  onReload: () => void
  onSave: () => void
  onSubmit: () => void
  onClose: () => void
  onTakeOver: () => void
  onUseTerminalVersion: () => void
  onKeepMine: () => void
}) {
  const unsupported = phase === 'unsupported'
  const locked = phase === 'locked'
  const conflict = phase === 'conflict'
  return (
    <div
      className="absolute inset-x-3 bottom-3 z-30 flex max-h-[55%] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating"
      role="region"
      aria-label="Terminal draft editor"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">Terminal draft</div>
          <div className="truncate text-xs text-muted-foreground" role="status">
            {status || (phase === 'loading' ? 'Reading the agent draft…' : '')}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {phase === 'editing' && (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onReload}
                disabled={busy}
                aria-label="Reload the terminal draft"
              >
                Reload
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={onSave}
                disabled={busy || actionsLocked || !dirty}
                aria-label="Save draft to terminal without submitting"
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onSubmit}
                disabled={busy || actionsLocked}
                aria-label="Write draft and press Enter once"
              >
                {busy ? <Loader2 className="animate-spin" /> : <Send />}
                Send
              </Button>
            </>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onClose}
            aria-label="Close terminal draft editor"
          >
            <X />
          </Button>
        </div>
      </div>

      {unsupported || locked ? (
        <div className="space-y-3 px-3 py-4 text-sm">
          <p className="text-muted-foreground">
            {locked
              ? `Another device is editing this terminal draft (${holder}).`
              : (reason ?? 'Draft editing is unavailable for this terminal.')}
          </p>
          {locked && (
            <Button type="button" size="sm" onClick={onTakeOver} disabled={busy}>
              Take over editing
            </Button>
          )}
          {!locked && (
            <p className="text-xs text-muted-foreground">
              Type in the terminal as usual. Nothing was changed.
            </p>
          )}
        </div>
      ) : (
        <>
          {conflict && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-xs">
              <span className="text-destructive">The terminal draft was changed elsewhere.</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onUseTerminalVersion}
                aria-label="Use the terminal draft version"
              >
                Use terminal version
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={onKeepMine}
                aria-label="Keep my draft text"
              >
                Keep my text
              </Button>
            </div>
          )}
          <Textarea
            value={text}
            onChange={(event) => onTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (isImeOwnedKeyboardEvent(event)) {
                return
              }
              if (isScreenSubmitShortcut(event)) {
                event.preventDefault()
                onSubmit()
              } else if (
                event.key.toLowerCase() === 's' &&
                (getShortcutPlatform() === 'darwin' ? event.metaKey : event.ctrlKey)
              ) {
                event.preventDefault()
                onSave()
              } else if (event.key === 'Escape') {
                onClose()
              }
            }}
            variant="code"
            className="min-h-24 flex-1"
            placeholder="Write the prompt here. Enter adds a line; Send presses Enter in the terminal."
            aria-label="Terminal draft text"
            spellCheck={false}
            disabled={phase === 'loading' || busy}
            autoFocus
          />
          <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>
              {dirty ? 'Unsaved local changes' : 'Matches the terminal draft'} · Enter adds a line,{' '}
              {getScreenSubmitShortcutLabel()} sends,{' '}
              {getShortcutPlatform() === 'darwin' ? '⌘S' : 'Ctrl+S'} saves
            </span>
            <span>{Array.from(text).length} chars</span>
          </div>
        </>
      )}
    </div>
  )
}
