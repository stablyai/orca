import { useCallback, useEffect, useRef, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  clearRecoveredDraft,
  readRecoveredDraft,
  resolveDraftRecovery,
  writeRecoveredDraft,
  type LocalRecovery
} from './terminal-draft-recovery'
import { TerminalDraftTrigger } from './TerminalDraftTrigger'
import { TerminalDraftPanel } from './TerminalDraftPanel'
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
  const clientIdRef = useRef(createBrowserUuid())
  const epochRef = useRef(0)
  const baseTokenRef = useRef('')
  const ptyIdRef = useRef<string | null>(null)
  const remoteTextRef = useRef('')
  const textRef = useRef('')
  const dirtyRef = useRef(false)
  const mountedRef = useRef(true)
  const cleanupRef = useRef<() => void>(() => {})
  dirtyRef.current = dirty

  const updateText = useCallback((value: string) => {
    textRef.current = value
    setText(value)
    setDirty(true)
  }, [])

  const releaseLease = useCallback(() => {
    const ptyId = ptyIdRef.current
    if (ptyId && epochRef.current > 0) {
      void releaseDesktopTerminalDraft(ptyId, clientIdRef.current, epochRef.current).catch(() => {})
    }
  }, [])

  cleanupRef.current = () => {
    mountedRef.current = false
    if (dirtyRef.current) {
      writeRecoveredDraft(recoveryKey, { text: textRef.current, remoteText: remoteTextRef.current })
    } else if (epochRef.current > 0) {
      // Why: this mount owned a lease, so its old record is stale; an unopened parked copy is not ours to erase.
      clearRecoveredDraft(recoveryKey)
    }
    releaseLease()
  }
  useEffect(() => {
    mountedRef.current = true
    return () => cleanupRef.current()
  }, [])

  const open = useCallback(
    async (force = false, parked?: LocalRecovery) => {
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
        const result = await beginDesktopTerminalDraft(ptyId, clientIdRef.current, force)
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
        if (!mountedRef.current) {
          void releaseDesktopTerminalDraft(ptyId, clientIdRef.current, result.epoch).catch(() => {})
          return
        }
        epochRef.current = result.epoch
        baseTokenRef.current = result.sourceToken
        remoteTextRef.current = result.text
        const resolved = resolveDraftRecovery({
          local: parked ?? readRecoveredDraft(recoveryKey),
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
      if (typeof result.text === 'string') {
        remoteTextRef.current = result.text
        textRef.current = result.text
        setText(result.text)
      } else {
        remoteTextRef.current = textRef.current
      }
      setDirty(false)
      setActionsLocked(false)
      setStatus(
        result.normalized
          ? 'Saved; the agent expanded tabs or line endings.'
          : result.replayed
            ? 'This draft was already saved to the terminal.'
            : 'Saved to terminal.'
      )
      return true
    }
    if (result.status === 'conflict') {
      // The conflict's token is the current terminal version, so either explicit choice can proceed.
      baseTokenRef.current = result.conflict.sourceToken
      remoteTextRef.current = result.conflict.text
      setConflictText(result.conflict.text)
      setPhase('conflict')
      setStatus('The terminal draft changed. Choose which version to keep.')
      return false
    }
    if (result.status === 'locked') {
      setStatus('Another device is using terminal input. Nothing was written.')
      return false
    }
    if (result.status === 'stale_binding') {
      setActionsLocked(true)
      setStatus('This terminal changed. Reopen the draft to continue.')
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
          clientId: clientIdRef.current,
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
        clientId: clientIdRef.current,
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
        if (typeof result.text === 'string') {
          remoteTextRef.current = result.text
          textRef.current = result.text
          setText(result.text)
        }
        setDirty(false)
        setActionsLocked(true)
        setStatus('Saved, but the terminal refused Enter. Submit from the terminal.')
        return
      }
      if (result.ok && result.status === 'submit_unknown') {
        baseTokenRef.current = result.sourceToken
        if (typeof result.text === 'string') {
          remoteTextRef.current = result.text
          textRef.current = result.text
          setText(result.text)
        }
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
    clearRecoveredDraft(recoveryKey)
    setConflictText(null)
    setPhase('editing')
    setStatus('Loaded the terminal version.')
  }, [conflictText, recoveryKey])

  const keepMine = useCallback(() => {
    setConflictText(null)
    setPhase('editing')
    setStatus('Saving will overwrite the terminal version.')
  }, [])

  if (phase === 'closed') {
    return <TerminalDraftTrigger onOpen={() => void open()} />
  }

  return (
    <TerminalDraftPanel
      phase={phase}
      status={status}
      text={text}
      dirty={dirty}
      busy={busy}
      actionsLocked={actionsLocked}
      holder={holder}
      reason={reason}
      onTextChange={updateText}
      onReload={() => {
        const parked = dirty ? { text, remoteText: remoteTextRef.current } : undefined
        // Why: the in-memory snapshot survives a full or unavailable localStorage.
        if (parked) {
          writeRecoveredDraft(recoveryKey, parked)
        }
        void open(false, parked)
      }}
      onSave={() => void save()}
      onSubmit={() => void submit()}
      onClose={close}
      onTakeOver={() => void open(true)}
      onUseTerminalVersion={useTerminalVersion}
      onKeepMine={keepMine}
    />
  )
}
