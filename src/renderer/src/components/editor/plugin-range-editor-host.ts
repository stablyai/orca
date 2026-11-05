import { EDITOR_RANGE_DIRTY_MESSAGE } from './editor-range-document'
import { z } from 'zod'
import { EDITOR_METHODS, FRAME_EVENTS } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import {
  pluginError,
  pluginEvent,
  pluginFailure,
  pluginResult,
  readPluginEnvelope,
  type PluginEnvelope,
  type PluginError
} from '../../../../shared/plugins/frames/plugin-protocol'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes
} from '../../../../shared/plugins/frames/plugin-panel-message-budget'
import type { RuntimeRangeDocument } from '@/runtime/runtime-range-document'
import type { CustomEditorHost, CustomEditorHostOptions } from './plugin-custom-editor-host-types'
import { handleCustomEditorFrameEvent } from './plugin-custom-editor-frame-events'

const emptyParamsSchema = z.strictObject({})
const editorMethods = new Set<string>(Object.values(EDITOR_METHODS))
type RangeWireRequest = {
  orca: 1
  kind: 'req'
  id: number
  method: 'editor.readRange'
  params: { version: number; offset: number; length: number }
}

function isPlainRangeObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function isRangeWireRequest(value: unknown): value is RangeWireRequest {
  if (
    !isPlainRangeObject(value) ||
    value.orca !== 1 ||
    value.kind !== 'req' ||
    value.method !== 'editor.readRange' ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id < 0
  ) {
    return false
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 5 ||
    !keys.every(
      (key) => typeof key === 'string' && ['orca', 'kind', 'id', 'method', 'params'].includes(key)
    )
  ) {
    return false
  }
  const params = value.params
  if (!isPlainRangeObject(params)) {
    return false
  }
  const fields = Reflect.ownKeys(params)
  return (
    fields.length === 3 &&
    fields.every(
      (key) => typeof key === 'string' && ['version', 'offset', 'length'].includes(key)
    ) &&
    typeof params.version === 'number' &&
    Number.isSafeInteger(params.version) &&
    params.version >= 0 &&
    typeof params.offset === 'number' &&
    Number.isSafeInteger(params.offset) &&
    params.offset >= 0 &&
    typeof params.length === 'number' &&
    Number.isSafeInteger(params.length) &&
    params.length >= 1 &&
    params.length <= 256 * 1024
  )
}

function rangeFailure(error: unknown): PluginError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
  const detail = error instanceof Error ? error.message : ''
  if (code === 'range_document_dirty') {
    return pluginError('not_permitted', EDITOR_RANGE_DIRTY_MESSAGE)
  }
  if (
    error instanceof z.ZodError ||
    code === 'range_document_invalid_range' ||
    detail.includes('range_document_invalid_range')
  ) {
    return pluginError('invalid_params', 'The requested document range is invalid.')
  }
  if (
    code === 'rate_limited' ||
    code === 'range_document_busy' ||
    detail.includes('range_document_busy')
  ) {
    return pluginError(
      'rate_limited',
      'The document already has unfinished reads. Try again when they settle.'
    )
  }
  if (
    code === 'cancelled' ||
    code === 'range_document_cancelled' ||
    detail.includes('range_document_cancelled')
  ) {
    return pluginError('cancelled', 'The document operation was cancelled.')
  }
  if (
    code === 'conflict' ||
    code === 'range_document_stale' ||
    code === 'range_document_changed' ||
    detail.includes('range_document_stale') ||
    detail.includes('range_document_changed')
  ) {
    return pluginError(
      'conflict',
      'The document changed. Discard old ranges and reload explicitly.'
    )
  }
  if (code === 'range_document_too_large' || detail.includes('range_document_too_large')) {
    return pluginError('too_large', 'The document exceeds the 1 GiB range limit.')
  }
  if (
    code === 'range_document_unsupported' ||
    code === 'range_document_unknown' ||
    code === 'method_not_found'
  ) {
    return pluginError(
      'unavailable',
      'This document source is unavailable. Check access or update its Orca host.'
    )
  }
  return pluginError(
    'action_failed',
    'The document operation failed. Check access and reload explicitly.'
  )
}

/** Only the frame owning this mounted document can call its range source. */
export function createRangeEditorHost(
  options: CustomEditorHostOptions,
  source: RuntimeRangeDocument,
  fileType: string
): CustomEditorHost {
  let ready = false
  let generation = 0
  const pending = new Map<number, { controller: AbortController; read: boolean }>()
  const budget = createPanelMessageBudget()
  const value = () => source.value(fileType)
  const post = (message: PluginEnvelope, transfer: Transferable[] = []) => {
    if (ready) {
      options.getFrameWindow()?.postMessage(message, '*', transfer)
    }
  }
  let unsubscribe: (() => void) | undefined
  const onInvalidate = () => {
    for (const entry of pending.values()) {
      if (entry.read) {
        entry.controller.abort()
      }
    }
    post(pluginEvent(FRAME_EVENTS.editorRangeInvalidated, value()))
  }
  return {
    channel: {
      claim(data) {
        const message = readPluginEnvelope(data)
        if (message?.kind === 'cancel') {
          const entry = pending.get(message.id)
          if (!entry) {
            return false
          }
          entry.controller.abort()
          return true
        }
        if (message?.kind !== 'req' || !editorMethods.has(message.method)) {
          return false
        }
        const { id, method, params } = message
        const messageBytes = structuredCloneMessageBytes(data, 64 * 1024)
        const range = messageBytes <= 1024 && isRangeWireRequest(data) ? data.params : null
        const refusal = range ? null : budget.admit(Date.now(), messageBytes)
        if (messageBytes > 64 * 1024 || refusal) {
          post(
            pluginFailure(
              id,
              pluginError(
                messageBytes > 64 * 1024 ? 'too_large' : 'rate_limited',
                'The ranged document request exceeds its message budget.'
              )
            )
          )
          return true
        }
        if (method === EDITOR_METHODS.readRange && !range) {
          post(
            pluginFailure(
              id,
              pluginError('invalid_params', 'The requested document range is invalid.')
            )
          )
          return true
        }
        if (method === EDITOR_METHODS.applyEdit) {
          post(pluginFailure(id, pluginError('not_permitted', 'Ranged documents are read-only.')))
          return true
        }
        if (!ready || pending.has(id) || pending.size >= 4) {
          post(pluginFailure(id, pluginError('unavailable', 'The document frame is unavailable.')))
          return true
        }
        const controller = new AbortController()
        const frameWindow = options.getFrameWindow()
        const currentGeneration = generation
        const sameFrame = () =>
          generation === currentGeneration && options.getFrameWindow() === frameWindow
        const entry = { controller, read: method === EDITOR_METHODS.readRange }
        pending.set(id, entry)
        const run = async (): Promise<unknown> => {
          if (range) {
            return source.read(range, controller.signal)
          }
          if (params !== undefined) {
            emptyParamsSchema.parse(params)
          }
          switch (method) {
            case EDITOR_METHODS.rangeSession:
              await source.bind()
              options.onFrameProgress?.('delivered')
              return value()
            case EDITOR_METHODS.reloadRanges:
              await source.reload()
              return value()
            case EDITOR_METHODS.closeRanges:
              source.close()
              return null
            default:
              throw new Error('Unknown ranged document method.')
          }
        }
        void run()
          .then(
            (result) => {
              if (controller.signal.aborted || !sameFrame()) {
                return
              }
              const bytes =
                result && typeof result === 'object' && 'bytes' in result ? result.bytes : null
              post(pluginResult(id, result), bytes instanceof ArrayBuffer ? [bytes] : [])
            },
            (error: unknown) => {
              if (controller.signal.aborted || !sameFrame()) {
                return
              }
              post(pluginFailure(id, rangeFailure(error)))
            }
          )
          .finally(() => {
            if (entry.read && controller.signal.aborted && sameFrame()) {
              post(pluginFailure(id, pluginError('cancelled', 'The document read was cancelled.')))
            }
            if (pending.get(id) === entry) {
              pending.delete(id)
            }
          })
        return true
      },
      onReady() {
        ready = true
        unsubscribe ??= source.onInvalidate(onInvalidate)
        post(pluginEvent(FRAME_EVENTS.editorRangeDocument, value()))
        if (source.requiresReload) {
          post(pluginEvent(FRAME_EVENTS.editorRangeInvalidated, value()))
        }
      },
      onEvent(event, context) {
        handleCustomEditorFrameEvent(event, context, options)
      },
      onResponse() {}
    },
    syncDocument() {},
    flush: () => Promise.resolve(true),
    currentText: () => '',
    mergeOutsideChange: () => Promise.resolve(null),
    reset() {
      ready = false
      generation += 1
      for (const entry of pending.values()) {
        entry.controller.abort()
      }
      pending.clear()
      source.close()
      unsubscribe?.()
      unsubscribe = undefined
    }
  }
}
