import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImeInput } from '@/lib/ime-text-field'
import { translate } from '@/i18n/i18n'
import { debugErrorMessage, type DebugSectionProps } from './debug-section-contract'

export const DEBUG_WATCH_STORAGE_PREFIX = 'orca.debug.watch:'

type WatchValue = { ok: true; value: string } | { ok: false; error: string }

function readWatches(worktreePath: string): string[] {
  try {
    const raw = window.localStorage.getItem(DEBUG_WATCH_STORAGE_PREFIX + worktreePath)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item) => typeof item === 'string'))]
      : []
  } catch {
    return []
  }
}

function writeWatches(worktreePath: string, expressions: string[]): void {
  try {
    window.localStorage.setItem(
      DEBUG_WATCH_STORAGE_PREFIX + worktreePath,
      JSON.stringify(expressions)
    )
  } catch {
    // Storage can be full or blocked; the list still works for this mount.
  }
}

export default function DebugWatchSection({
  client,
  target,
  session
}: DebugSectionProps): React.JSX.Element {
  const { worktreePath } = target
  const { selectedFrameId: frameId, selectionEpoch, stopSeq } = session
  const [expressions, setExpressions] = useState(() => readWatches(worktreePath))
  const [values, setValues] = useState<Record<string, WatchValue>>({})
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{
    index: number
    text: string
  } | null>(null)

  useEffect(() => {
    setExpressions(readWatches(worktreePath))
  }, [worktreePath])

  // One row per expression, so a duplicate add or edit collapses into the existing row.
  const update = (next: string[]): void => {
    const unique = [...new Set(next)]
    setExpressions(unique)
    writeWatches(worktreePath, unique)
  }

  useEffect(() => {
    let current = true
    setValues({})
    if (frameId === null) {
      return
    }
    for (const expression of expressions) {
      client
        .evaluate({ ...target, expression, frameId, context: 'watch' })
        .then((result): WatchValue =>
          result.ok
            ? { ok: true, value: result.value.result }
            : { ok: false, error: result.message }
        )
        .catch((caught: unknown): WatchValue => ({
          ok: false,
          error: debugErrorMessage(caught)
        }))
        .then((value) => {
          if (current) {
            setValues((previous) => ({ ...previous, [expression]: value }))
          }
        })
    }
    return () => {
      current = false
    }
    // stopSeq: a step re-stops the same thread, often on the same frame id.
  }, [client, target, frameId, selectionEpoch, stopSeq, expressions])

  const commitEdit = (): void => {
    if (!editing) {
      return
    }
    const text = editing.text.trim()
    update(
      text
        ? expressions.map((expression, i) => (i === editing.index ? text : expression))
        : expressions.filter((_, i) => i !== editing.index)
    )
    setEditing(null)
  }

  const startEdit = (index: number, text: string): void => setEditing({ index, text })

  return (
    <div>
      {expressions.map((expression, index) => {
        const value = values[expression]
        return (
          <div
            key={expression}
            className="group flex items-center gap-1 py-0.5 pl-6 pr-1 hover:bg-accent"
            data-testid="debug-watch-row"
          >
            {editing?.index === index ? (
              <ImeInput
                autoFocus
                aria-label={translate('debug.watch.editExpression', 'Edit expression')}
                className="min-w-0 flex-1 rounded-sm border border-ring bg-transparent px-1 font-mono text-xs text-foreground outline-none"
                value={editing.text}
                onChange={(event) => setEditing({ index, text: event.target.value })}
                onBlur={commitEdit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitEdit()
                  } else if (event.key === 'Escape') {
                    setEditing(null)
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="min-w-0 max-w-[50%] shrink-0 truncate text-left font-mono text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                title={expression}
                aria-keyshortcuts="F2"
                onDoubleClick={() => startEdit(index, expression)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'F2') {
                    event.preventDefault()
                    startEdit(index, expression)
                  }
                }}
              >
                {expression}
              </button>
            )}
            <span className="shrink-0 text-muted-foreground">=</span>
            {frameId === null ? (
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {translate('debug.watch.notAvailable', 'not available')}
              </span>
            ) : value?.ok === false ? (
              <span
                role="alert"
                className="min-w-0 flex-1 truncate text-destructive"
                title={value.error}
              >
                {value.error}
              </span>
            ) : (
              <span
                className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                title={value?.value}
              >
                {value ? (
                  value.value
                ) : (
                  <>
                    <span aria-hidden>…</span>
                    <span className="sr-only">
                      {translate('debug.watch.evaluating', 'Evaluating')}
                    </span>
                  </>
                )}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="-my-1 shrink-0"
              aria-label={translate('debug.watch.remove', 'Remove expression')}
              onClick={() => update(expressions.filter((_, i) => i !== index))}
            >
              <X className="size-3" />
            </Button>
          </div>
        )
      })}
      <div className="px-2 py-1">
        <ImeInput
          aria-label={translate('debug.watch.add', 'Add expression')}
          placeholder={translate('debug.watch.add', 'Add expression')}
          className="w-full min-w-0 rounded-sm border border-input bg-transparent px-2 py-0.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            const text = draft.trim()
            if (event.key === 'Enter' && text) {
              update([...expressions, text])
              setDraft('')
            }
          }}
        />
      </div>
    </div>
  )
}
