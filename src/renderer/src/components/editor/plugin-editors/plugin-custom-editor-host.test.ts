import { describe, expect, it, vi } from 'vitest'
import { CUSTOM_EDITOR_DOCUMENT_MAX_BYTES } from '../../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { isPluginJsonObject } from '../../../../../shared/plugins/manifest/plugin-json-object'
import { createPanelMessageBudget } from '../../../../../shared/plugins/frames/plugin-panel-message-budget'
import {
  createPluginFrameMessageHandler,
  type PluginFrameHostOptions
} from '../../plugins/frames/plugin-frame-host'
import { createCustomEditorHost } from './plugin-custom-editor-host'
import type { CustomEditorHostOptions } from './plugin-custom-editor-host-types'

vi.mock('../../plugins/frames/plugin-panel-design-token-css', () => ({
  currentPluginFrameTheme: () => ({ colorScheme: 'light', tokens: '' })
}))

/** Drives the editor host through the frame host, exactly as the frame's `window.orca` would. */

const READY = { orca: 1, kind: 'evt', event: 'ready', payload: { protocol: 1 } }
let nextId = 100
const applyEdit = (content: unknown, baseVersion = 1, id = nextId++) => ({
  orca: 1,
  kind: 'req',
  id,
  method: 'editor.applyEdit',
  params: { baseVersion, content }
})
const edit = (text: string, baseVersion = 1, id?: number) =>
  applyEdit({ kind: 'text', text }, baseVersion, id)

type FrameSend = (data: unknown, source?: unknown) => void

function iframeSender(frameHost: PluginFrameHostOptions, frameWindow: unknown): FrameSend {
  const handler = createPluginFrameMessageHandler(frameHost)
  return (data, source = frameWindow) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only data and source.
    handler({ data, source } as unknown as MessageEvent)
}

function harness(options: Omit<CustomEditorHostOptions, 'getFrameWindow'>) {
  const posted: unknown[] = []
  const frameWindow = {
    postMessage: (message: unknown) => posted.push(message)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hosts only call postMessage and compare identity.
  const getFrameWindow = () => frameWindow as unknown as Window
  const host = createCustomEditorHost({ ...options, getFrameWindow })
  const frameHost = {
    surface: 'editor' as const,
    getFrameWindow,
    getSessionToken: () => null,
    editor: host.channel
  }
  const send = iframeSender(frameHost, frameWindow)
  const answerFlushes = () => {
    for (const message of posted) {
      if (isPluginJsonObject(message) && message.method === 'editor.flush') {
        send({ orca: 1, kind: 'res', id: message.id, result: null })
      }
    }
  }
  return { host, send, answerFlushes }
}

function setupWith(initial: { text: string; onMergesOutside: () => void }) {
  const doc = { text: initial.text, readOnly: false }
  return harness({
    getDocument: () => doc,
    onEdit: (text) => {
      doc.text = text
    },
    onMergesOutside: initial.onMergesOutside,
    flushTimeoutMs: 1_000
  })
}

function setup(initial: { text: string; maxEdits?: number; now?: () => number }) {
  const doc = { text: initial.text, readOnly: false }
  return harness({
    getDocument: () => doc,
    onEdit: (text) => {
      doc.text = text
    },
    flushTimeoutMs: 50,
    ...(initial.now ? { now: initial.now } : {}),
    ...(initial.maxEdits === undefined
      ? {}
      : {
          budget: createPanelMessageBudget({
            maxBytes: CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
            maxMessages: initial.maxEdits,
            perMs: 60_000
          })
        })
  })
}

describe('custom editor document channel', () => {
  it('blocks a save after an oversized edit until the frame catches up', async () => {
    const { host, send, answerFlushes } = setup({
      text: 'a'
    })
    send(READY)
    send(edit('x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1), 1, 12))
    const flushed = host.flush()
    answerFlushes()
    // The buffer lacks the frame's latest change: a save must not mark the tab clean.
    await expect(flushed).resolves.toBe(false)
    send(edit('fits'))
    const caughtUp = host.flush()
    answerFlushes()
    await expect(caughtUp).resolves.toBe(true)
  })

  it('keeps a save blocked when an oversized edit follows a held edit', async () => {
    let clock = 0
    const { host, send, answerFlushes } = setup({
      text: 'a',
      maxEdits: 1,
      now: () => clock
    })
    send(READY)
    send(edit('b', 1, 19))
    send(edit('c', 1, 20))
    // A new rate window, so the next edit is refused for its size alone.
    clock = 60_000
    send(edit('x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1), 1, 21))
    const flushed = host.flush()
    answerFlushes()
    // The frame's newest change was lost, so a save must not mark the tab clean.
    await expect(flushed).resolves.toBe(false)
  })

  it('answers null when the session never acknowledges, or the frame remounts', async () => {
    vi.useFakeTimers()
    try {
      const { host, send } = setupWith({ text: 'a', onMergesOutside: vi.fn() })
      send(READY)
      send({ orca: 1, kind: 'evt', event: 'editor.merges', payload: {} })
      const silent = host.mergeOutsideChange('b', 'a')
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(silent).resolves.toBeNull()
      // A frame whose merge threw edits against the old version: refused, never the acknowledgement.
      const failed = host.mergeOutsideChange('b2', 'a')
      send(edit('a+typed', 1, 77))
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(failed).resolves.toBeNull()
      const remounted = host.mergeOutsideChange('c', 'a')
      host.reset()
      await expect(remounted).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
