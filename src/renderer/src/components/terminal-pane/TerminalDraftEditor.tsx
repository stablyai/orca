import { useCallback, useRef, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  clearRecoveredDraft,
  readRecoveredDraft,
  resolveDraftRecovery,
  writeRecoveredDraft
} from './terminal-draft-recovery'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Send, X } from 'lucide-react'
import { TerminalDraftTrigger } from './TerminalDraftTrigger'
import type {
  TerminalDraftSaveResult,
  TerminalDraftSubmitResult
} from '../../../../shared/terminal-draft-contract'
import {
  beginDesktopTerminalDraft,
  releaseDesktopTerminalDraft,
  saveDesktopTerminalDraft,
  submitDesktopTerminalDraft
} from '@/runtime/terminal-draft-client'

type DraftPhase = 'closed' | 'loading' | 'editing' | 'locked' | 'unsupported' | 'conflict'

function operationId(): string {
  return createBrowserUuid()
}

export function TerminalDraftEditor({
  recoveryKey,
  getPtyId
}: {
  /** Stable pane identity, so a reconnect under a new PTY can still find the local copy. */
  recoveryKey: string
  getPtyId: () => string | null
}) {
  const [phase, setPhase] = useState<DraftPhase>('closed')
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [reason, setReason] = useState('')
  const [holder, setHolder] = useState<string | null>(null)
  const [conflictText, setConflictText] = useState<string | null>(null)
  const [actionsLocked, setActionsLocked] = useState(false)
  const epochRef = useRef(0)
  const baseTokenRef = useRef('')
  const ptyIdRef = useRef<string | null>(null)
  const remoteTextRef = useRef('')
  const textRef = useRef('')

  const updateText = useCallback((value: string) => {
    textRef.current = value
    setText(value)
    setDirty(true)
  }, [])

  const releaseLease = useCallback(() => {
    const ptyId = ptyIdRef.current
    if (ptyId && epochRef.current > 0) {
      void releaseDesktopTerminalDraft(ptyId, epochRef.current).catch(() => {})
    }
  }, [])

  const open = useCallback(
    async (force = false) => {
      const ptyId = getPtyId()
      if (!ptyId) {
        setPhase('unsupported')
        setReason('No live remote terminal for this pane.')
        return
      }
      ptyIdRef.current = ptyId
      setPhase('loading')
      setBusy(true)
      setStatus('')
      setActionsLocked(false)
      try {
        const result = await beginDesktopTerminalDraft(ptyId, force)
        if (!result.ok) {
          if (result.reason === 'locked') {
            setPhase('locked')
            setHolder(`${result.holder.clientType} · ${result.holder.clientId}`)
            return
          }
          setPhase('unsupported')
          setReason(
            !result.supported && result.reason === 'no_bridge'
              ? 'This agent does not expose a readable draft. Keep typing in the terminal.'
              : result.supported
                ? 'The agent did not answer its draft bridge.'
                : 'This agent version cannot read or replace its draft.'
          )
          return
        }
        epochRef.current = result.epoch
        baseTokenRef.current = result.sourceToken
        remoteTextRef.current = result.text
        const resolved = resolveDraftRecovery({
          local: readRecoveredDraft(recoveryKey),
          remoteText: result.text,
          remoteToken: result.sourceToken
        })
        textRef.current = resolved.text
        setText(resolved.text)
        setDirty(resolved.dirty)
        setConflictText(resolved.conflict ? result.text : null)
        setPhase(resolved.conflict ? 'conflict' : 'editing')
        setStatus(
          resolved.conflict
            ? 'The terminal draft changed since you closed this editor.'
            : resolved.dirty
              ? 'Restored your unsaved local copy.'
              : 'Editing the terminal draft.'
        )
      } catch {
        setPhase('unsupported')
        setReason('Could not reach the agent draft bridge.')
      } finally {
        setBusy(false)
      }
    },
    [getPtyId, recoveryKey]
  )

  const close = useCallback(() => {
    if (dirty) {
      writeRecoveredDraft(recoveryKey, { text, remoteText: remoteTextRef.current })
    } else {
      clearRecoveredDraft(recoveryKey)
    }
    releaseLease()
    ptyIdRef.current = null
    epochRef.current = 0
    setPhase('closed')
    setConflictText(null)
    setStatus('')
  }, [dirty, recoveryKey, releaseLease, text])

  const applySaveResult = useCallback((result: TerminalDraftSaveResult): boolean => {
    if (result.ok) {
      baseTokenRef.current = result.sourceToken
      remoteTextRef.current = textRef.current
      setDirty(false)
      setActionsLocked(false)
      setStatus(
        result.replayed ? 'This draft was already saved to the terminal.' : 'Saved to terminal.'
      )
      return true
    }
    if (result.status === 'conflict') {
      setConflictText(result.conflict.text)
      setPhase('conflict')
      setStatus('The terminal draft changed. Choose which version to keep.')
      return false
    }
    if (result.status === 'stale_lease') {
      setActionsLocked(true)
      setStatus('This edit session expired. Reopen the draft to continue.')
      return false
    }
    if (result.status === 'unknown') {
      setActionsLocked(true)
      setStatus('Result unknown. Check the terminal before retrying.')
      return false
    }
    setPhase('unsupported')
    setReason('The agent stopped exposing its draft bridge.')
    return false
  }, [])

  const save = useCallback(async () => {
    const ptyId = ptyIdRef.current
    if (!ptyId || busy || actionsLocked) {
      return
    }
    setBusy(true)
    try {
      applySaveResult(
        await saveDesktopTerminalDraft({
          ptyId,
          epoch: epochRef.current,
          baseToken: baseTokenRef.current,
          text: textRef.current,
          operationId: operationId()
        })
      )
    } catch {
      setActionsLocked(true)
      setStatus('Result unknown. Check the terminal before retrying.')
    } finally {
      setBusy(false)
    }
  }, [actionsLocked, applySaveResult, busy])

  const submit = useCallback(async () => {
    const ptyId = ptyIdRef.current
    if (!ptyId || busy || actionsLocked || textRef.current.trim().length === 0) {
      return
    }
    setBusy(true)
    try {
      const result: TerminalDraftSubmitResult = await submitDesktopTerminalDraft({
        ptyId,
        epoch: epochRef.current,
        baseToken: baseTokenRef.current,
        text: textRef.current,
        operationId: operationId()
      })
      if (result.ok && result.status === 'submitted') {
        clearRecoveredDraft(recoveryKey)
        releaseLease()
        ptyIdRef.current = null
        epochRef.current = 0
        setDirty(false)
        setPhase('closed')
        setStatus('')
        return
      }
      if (result.ok && result.status === 'saved_not_submitted') {
        baseTokenRef.current = result.sourceToken
        setDirty(false)
        setActionsLocked(true)
        setStatus('Saved, but the terminal refused Enter. Submit from the terminal.')
        return
      }
      if (result.ok && result.status === 'submit_unknown') {
        baseTokenRef.current = result.sourceToken
        setDirty(false)
        setActionsLocked(true)
        setStatus('Enter may not have been delivered. Check the terminal before retrying.')
        return
      }
      applySaveResult(result)
    } catch {
      setActionsLocked(true)
      setStatus('Result unknown. Check the terminal before retrying.')
    } finally {
      setBusy(false)
    }
  }, [actionsLocked, applySaveResult, busy, recoveryKey, releaseLease])

  const useTerminalVersion = useCallback(() => {
    if (conflictText === null) {
      return
    }
    remoteTextRef.current = conflictText
    textRef.current = conflictText
    setText(conflictText)
    setDirty(false)
    setConflictText(null)
    setPhase('editing')
    setStatus('Loaded the terminal version.')
  }, [conflictText])

  const keepMine = useCallback(() => {
    setConflictText(null)
    setPhase('editing')
    setStatus('Saving will overwrite the terminal version.')
  }, [])

  if (phase === 'closed') {
    return <TerminalDraftTrigger onOpen={() => void open()} />
  }

  const unsupported = phase === 'unsupported'
  const locked = phase === 'locked'
  const conflict = phase === 'conflict'

  return (
    <div
      className="absolute inset-x-3 bottom-3 z-30 flex max-h-[55%] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      role="dialog"
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
                onClick={() => void open()}
                disabled={busy}
                aria-label="Reload the terminal draft"
              >
                Reload
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void save()}
                disabled={busy || actionsLocked || !dirty}
                aria-label="Save draft to terminal without submitting"
              >
                {busy ? <Loader2 className="animate-spin" /> : null}
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void submit()}
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
            onClick={close}
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
            <Button type="button" size="sm" onClick={() => void open(true)} disabled={busy}>
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
              <Button type="button" size="xs" variant="outline" onClick={useTerminalVersion}>
                Use terminal version
              </Button>
              <Button type="button" size="xs" variant="outline" onClick={keepMine}>
                Keep my text
              </Button>
            </div>
          )}
          <Textarea
            value={text}
            onChange={(event) => updateText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void submit()
              } else if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void save()
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
              {dirty ? 'Unsaved local changes' : 'Matches the terminal draft'} · Enter adds a line,
              ⌘/Ctrl+Enter sends
            </span>
            <span>{Array.from(text).length} chars</span>
          </div>
        </>
      )}
    </div>
  )
}
