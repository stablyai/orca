import {
  CUSTOM_EDITOR_CONFLICT,
  CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
  CUSTOM_EDITOR_EDIT_RATE_LIMIT,
  CUSTOM_EDITOR_FLUSH_TIMEOUT_MS,
  CUSTOM_EDITOR_TOO_LARGE,
  isCustomEditorEditAttempt,
  readCustomEditorEdit,
  readCustomEditorKeyChord,
  type CustomEditorDocument,
  type CustomEditorEdit,
  type CustomEditorKeyChord
} from '../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { EDITOR_METHODS, FRAME_EVENTS } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import {
  pluginError,
  pluginEvent,
  pluginFailure,
  pluginRequest,
  pluginRequestId,
  pluginResult,
  readPluginEnvelope,
  type PluginEnvelope,
  type PluginError
} from '../../../../shared/plugins/frames/plugin-protocol'
import type { PluginFrameEditorChannel } from '../right-sidebar/plugin-frame-host'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/frames/plugin-panel-message-budget'

export type CustomEditorEditRefusal = 'oversized' | 'rate_limited'

/** Why an edit has not reached the buffer: held for the rate limit, or lost for size. */
export type CustomEditorUnappliedEdit = 'held' | 'lost' | null

/** A binary editor's document; a new object means new bytes to send. */
export type CustomEditorBinaryDocument = { bytes: Uint8Array<ArrayBuffer>; fileType: string }

export type CustomEditorHostOptions = {
  getFrameWindow: () => Window | null
  /** The buffer as Orca holds it now. */
  getDocument: () => { text: string; readOnly: boolean }
  /** Binary editors only: the document's bytes, or null while they load. */
  getBinaryDocument?: () => CustomEditorBinaryDocument | null
  onEdit: (text: string) => void
  /** Binary editors: the frame's full replacement; the host then treats it as what the frame holds. */
  onBytesEdit?: (document: CustomEditorBinaryDocument) => void
  onEditRefused?: (reason: CustomEditorEditRefusal) => void
  /** The frame holds edits the buffer lacks, or caught up again. */
  onUnappliedEdit?: (state: CustomEditorUnappliedEdit) => void
  onKeyChord?: (chord: CustomEditorKeyChord) => void
  /** The edit lane; every other message spends the frame's shared budget. */
  budget?: PanelMessageBudget
  now?: () => number
  flushTimeoutMs?: number
}

export type CustomEditorHost = {
  /** Plugged into the frame host for this editor's frame. */
  channel: PluginFrameEditorChannel
  /** Push the buffer when it changed outside the frame (reload, revert, Source edits). */
  syncDocument: () => void
  /** Waits for edits still in the frame's debounce window; false on timeout or when an edit
   *  never reached the buffer, so a save must not mark the tab clean. */
  flush: () => Promise<boolean>
  /** The newest text either side holds: the frame's last edit or the buffer last sent. */
  currentText: () => string
  /** A new document mounted in the frame; it must announce ready again. */
  reset: () => void
}

/** The frame only ever holds the document: Orca owns the buffer, dirty state and save. */
export function createCustomEditorHost(options: CustomEditorHostOptions): CustomEditorHost {
  const budget =
    options.budget ??
    createPanelMessageBudget({
      maxBytes: CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
      ...CUSTOM_EDITOR_EDIT_RATE_LIMIT
    })
  const now = options.now ?? (() => Date.now())
  const flushTimeoutMs = options.flushTimeoutMs ?? CUSTOM_EDITOR_FLUSH_TIMEOUT_MS
  let ready = false
  // What the frame is known to hold, so its own edits are never echoed back.
  let frameText: string | null = null
  let frameReadOnly: boolean | null = null
  let frameBinary: CustomEditorBinaryDocument | null = null
  // The version of the last document sent; edits against an older one are refused.
  let version = 0
  let nextFlushId = 0
  const pendingFlushes = new Map<number, (answered: boolean) => void>()
  // The newest edit refused for the rate limit, unparsed until applied; full-text, so it wins.
  let heldEdit: unknown = null
  let heldId: number | null = null
  let heldTimer: ReturnType<typeof setTimeout> | null = null
  let lostEdit = false
  let unapplied: CustomEditorUnappliedEdit = null

  const reportUnapplied = (): void => {
    const next = lostEdit ? 'lost' : heldEdit !== null ? 'held' : null
    if (next !== unapplied) {
      unapplied = next
      options.onUnappliedEdit?.(next)
    }
  }

  const post = (message: PluginEnvelope, transfer: Transferable[] = []) => {
    // Opaque srcdoc origins require targetOrigin '*'.
    options.getFrameWindow()?.postMessage(message, '*', transfer)
  }

  const answer = (id: number | null, error: PluginError | null): void => {
    if (id !== null) {
      post(error ? pluginFailure(id, error) : pluginResult(id, null))
    }
  }

  const postDocument = (document: CustomEditorDocument, transfer: Transferable[] = []): void => {
    post(pluginEvent(FRAME_EVENTS.editorDocument, document), transfer)
  }

  const pushBinaryDocument = (force: boolean, binary: CustomEditorBinaryDocument | null): void => {
    if (!binary || (!force && binary === frameBinary)) {
      return
    }
    frameBinary = binary
    // Why a copy: transferring detaches the buffer, and a remounted frame needs the bytes again.
    const bytes = binary.bytes.slice().buffer
    version += 1
    postDocument(
      {
        version,
        readOnly: options.getDocument().readOnly,
        fileType: binary.fileType,
        content: { kind: 'bytes', bytes }
      },
      [bytes]
    )
  }

  const pushDocument = (force: boolean): void => {
    if (!ready) {
      return
    }
    if (options.getBinaryDocument) {
      pushBinaryDocument(force, options.getBinaryDocument())
      return
    }
    const { text, readOnly } = options.getDocument()
    if (!force && text === frameText && readOnly === frameReadOnly) {
      return
    }
    frameText = text
    frameReadOnly = readOnly
    version += 1
    postDocument({ version, readOnly, content: { kind: 'text', text } })
  }

  const applyEdit = ({ content, baseVersion }: CustomEditorEdit): PluginError | null => {
    const binary = options.getBinaryDocument
    if (!ready || (binary && !frameBinary)) {
      return pluginError('unavailable', 'The document is not loaded yet.')
    }
    if (options.getDocument().readOnly) {
      return pluginError('not_permitted', 'This document is read-only.')
    }
    if (content.kind !== (binary ? 'bytes' : 'text')) {
      return pluginError(
        'invalid_params',
        `content.kind: this editor edits ${binary ? 'bytes' : 'text'}`
      )
    }
    if (baseVersion !== version) {
      return CUSTOM_EDITOR_CONFLICT
    }
    // A newer full document supersedes anything held back or lost.
    lostEdit = false
    reportUnapplied()
    if (content.kind === 'bytes') {
      frameBinary = { bytes: new Uint8Array(content.bytes), fileType: frameBinary?.fileType ?? '' }
      options.onBytesEdit?.(frameBinary)
      return null
    }
    if (content.text !== frameText) {
      frameText = content.text
      options.onEdit(content.text)
    }
    return null
  }

  /** Applies an admitted edit message and answers it. */
  const receiveEdit = (data: unknown): void => {
    const message = readPluginEnvelope(data)
    const edit = message?.kind === 'req' ? readCustomEditorEdit(message.params) : null
    const id = pluginRequestId(data)
    answer(id, edit ? applyEdit(edit) : pluginError('invalid_params', 'malformed editor edit'))
  }

  const applyHeldEdit = (): void => {
    if (heldTimer !== null) {
      clearTimeout(heldTimer)
      heldTimer = null
    }
    const held = heldEdit
    heldEdit = null
    heldId = null
    if (held !== null) {
      receiveEdit(held)
    }
    reportUnapplied()
  }

  /** A newer full-document edit carries the held one's intent, so the held one succeeds. */
  const supersedeHeldEdit = (): void => {
    answer(heldId, null)
    heldEdit = null
    heldId = null
  }

  const refuseEdit = (data: unknown, refusal: CustomEditorEditRefusal): void => {
    options.onEditRefused?.(refusal)
    if (refusal === 'oversized') {
      supersedeHeldEdit()
      lostEdit = true
      answer(pluginRequestId(data), CUSTOM_EDITOR_TOO_LARGE)
    } else {
      supersedeHeldEdit()
      heldEdit = data
      heldId = pluginRequestId(data)
      heldTimer ??= setTimeout(applyHeldEdit, CUSTOM_EDITOR_EDIT_RATE_LIMIT.perMs)
    }
    reportUnapplied()
  }

  const settleFlushes = (): void => {
    for (const settle of pendingFlushes.values()) {
      settle(true)
    }
    pendingFlushes.clear()
  }

  return {
    channel: {
      claim(data) {
        if (!isCustomEditorEditAttempt(data)) {
          return false
        }
        // Budget before parsing so floods cannot spend unmetered validation work.
        const refusal = budget.admit(
          now(),
          structuredCloneMessageBytes(data, CUSTOM_EDITOR_DOCUMENT_MAX_BYTES)
        )
        if (refusal) {
          refuseEdit(data, refusal)
          return true
        }
        // An admitted edit is newer than any held one.
        supersedeHeldEdit()
        receiveEdit(data)
        reportUnapplied()
        return true
      },
      onReady() {
        ready = true
        pushDocument(true)
      },
      onEvent(event) {
        const chord =
          event.event === FRAME_EVENTS.editorKeydown
            ? readCustomEditorKeyChord(event.payload)
            : null
        if (chord) {
          options.onKeyChord?.(chord)
        }
      },
      onResponse(response) {
        pendingFlushes.get(response.id)?.(response.error === undefined)
        pendingFlushes.delete(response.id)
      }
    },
    syncDocument() {
      pushDocument(false)
    },
    flush() {
      if (!ready) {
        return Promise.resolve(!lostEdit)
      }
      const requestId = nextFlushId++
      return new Promise<boolean>((resolve) => {
        const settle = (answered: boolean): void => {
          pendingFlushes.delete(requestId)
          // A save applies the newest held edit now instead of waiting out the rate limit.
          applyHeldEdit()
          resolve(answered && !lostEdit)
        }
        const timer = setTimeout(() => settle(false), flushTimeoutMs)
        pendingFlushes.set(requestId, (answered) => {
          clearTimeout(timer)
          settle(answered)
        })
        post(pluginRequest(requestId, EDITOR_METHODS.flush))
      })
    },
    currentText() {
      return frameText ?? options.getDocument().text
    },
    reset() {
      // Why apply, not drop: a view switch unmounts the frame, and a held edit is the newest content.
      if (heldEdit !== null) {
        applyHeldEdit()
      }
      ready = false
      frameText = null
      frameReadOnly = null
      frameBinary = null
      heldEdit = null
      heldId = null
      lostEdit = false
      if (heldTimer !== null) {
        clearTimeout(heldTimer)
        heldTimer = null
      }
      reportUnapplied()
      settleFlushes()
    }
  }
}
