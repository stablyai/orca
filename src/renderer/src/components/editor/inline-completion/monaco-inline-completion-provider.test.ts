// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnMount } from '@monaco-editor/react'
import type { CancellationToken, editor, languages, Position } from 'monaco-editor'
import {
  INLINE_COMPLETION_PREFIX_MAX_CHARS,
  INLINE_COMPLETION_SUFFIX_MAX_CHARS
} from '../../../../../shared/plugins/events/plugin-hook-payloads'
import { setupInlineCompletion } from './monaco-inline-completion-provider'

const wanted = vi.hoisted(() => ({ value: true }))
vi.mock('../plugin-editor-hook-wanted', () => ({ pluginEditorHookWanted: () => wanted.value }))

type MonacoApi = Parameters<OnMount>[1]

const TEXT = 'const x = ;'
const CURSOR_COLUMN = 11

// Mutable fake editor state that tests change while a request is in flight.
const world: { version: number; cursor: { lineNumber: number; column: number } | null } = {
  version: 1,
  cursor: null
}

function fakeModel(text: string): editor.ITextModel {
  const clamp = (offset: number): number => Math.min(Math.max(offset, 0), text.length)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The provider reads only these offset and range methods.
  return {
    getVersionId: () => world.version,
    getOffsetAt: (position: Position) => position.column - 1,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: clamp(offset) + 1 }),
    getValueInRange: (range: { startColumn: number; endColumn: number }) =>
      text.slice(range.startColumn - 1, range.endColumn - 1)
  } as unknown as editor.ITextModel
}

function fakeToken(): { token: CancellationToken; cancel: () => void } {
  const listeners: (() => void)[] = []
  const state = { cancelled: false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The provider reads only these two token members.
  const token = {
    get isCancellationRequested() {
      return state.cancelled
    },
    onCancellationRequested: (listener: () => void) => {
      listeners.push(listener)
      return { dispose() {} }
    }
  } as unknown as CancellationToken
  return {
    token,
    cancel: () => {
      state.cancelled = true
      listeners.forEach((listener) => listener())
    }
  }
}

let lastProvider: languages.InlineCompletionsProvider | undefined

function mountProvider(text = TEXT, cursorColumn = CURSOR_COLUMN) {
  let provider: languages.InlineCompletionsProvider | undefined
  const model = fakeModel(text)
  const api = {
    editor: {
      getEditors: () =>
        world.cursor
          ? [{ getModel: () => model, hasTextFocus: () => true, getPosition: () => world.cursor }]
          : []
    },
    languages: {
      registerInlineCompletionsProvider: vi.fn(
        (_selector: string, next: languages.InlineCompletionsProvider) => {
          provider = next
          lastProvider = next
          return { dispose() {} }
        }
      )
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Setup uses only this languages API.
  setupInlineCompletion(api as unknown as MonacoApi, model, {
    workspaceId: 'wt1',
    path: 'a.ts',
    languageRef: { current: 'typescript' },
    readOnlyRef: { current: false }
  })
  const position = { lineNumber: 1, column: cursorColumn } as Position
  return (token: CancellationToken) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The provider ignores the inline completion context.
    provider!.provideInlineCompletions(
      model,
      position,
      {} as languages.InlineCompletionContext,
      token
    )
}

describe('inline completion provider', () => {
  const run = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    wanted.value = true
    world.version = 1
    world.cursor = null
    run.mockReset().mockResolvedValue({ suggestion: '42' })
    Object.assign(window, { api: { plugins: { editorInlineCompletion: run } } })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('implements the dispose hook Monaco calls when a suggestion is accepted', () => {
    mountProvider()

    expect(typeof lastProvider?.disposeInlineCompletions).toBe('function')
  })

  it('asks the plugin after a pause and offers its suggestion at the cursor', async () => {
    const ask = mountProvider()
    const pending = ask(fakeToken().token)
    await vi.advanceTimersByTimeAsync(300)
    const result = await pending

    expect(run).toHaveBeenCalledWith({
      workspaceId: 'wt1',
      path: 'a.ts',
      languageId: 'typescript',
      prefix: 'const x = ',
      suffix: ';'
    })
    expect(result?.items).toEqual([
      {
        insertText: '42',
        range: { startLineNumber: 1, startColumn: 11, endLineNumber: 1, endColumn: 11 }
      }
    ])
  })

  it('sends only the capped text around the cursor, never the whole file', async () => {
    const before = 'a'.repeat(INLINE_COMPLETION_PREFIX_MAX_CHARS + 500)
    const after = 'b'.repeat(INLINE_COMPLETION_SUFFIX_MAX_CHARS + 500)
    const ask = mountProvider(`${before}|${after}`, before.length + 2)
    world.cursor = { lineNumber: 1, column: before.length + 2 }
    const pending = ask(fakeToken().token)
    await vi.advanceTimersByTimeAsync(300)
    await pending

    const sent = run.mock.calls[0][0] as { prefix: string; suffix: string }
    expect(sent.prefix).toHaveLength(INLINE_COMPLETION_PREFIX_MAX_CHARS)
    expect(sent.prefix.endsWith('|')).toBe(true)
    expect(sent.suffix).toHaveLength(INLINE_COMPLETION_SUFFIX_MAX_CHARS)
    expect(sent.suffix.startsWith('b')).toBe(true)
  })

  it('does not ask when no plugin lists the hook', async () => {
    wanted.value = false
    const result = await mountProvider()(fakeToken().token)

    expect(result?.items).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('does not ask when the cursor moved during the pause', async () => {
    const { token, cancel } = fakeToken()
    const pending = mountProvider()(token)
    cancel()

    expect((await pending)?.items).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('drops a slow answer for a cursor that already moved', async () => {
    const { token, cancel } = fakeToken()
    run.mockImplementation(async () => {
      cancel()
      return { suggestion: '42' }
    })
    const pending = mountProvider()(token)
    await vi.advanceTimersByTimeAsync(300)

    expect((await pending)?.items).toEqual([])
  })

  it('drops an answer when the text changed while the plugin was thinking', async () => {
    run.mockImplementation(async () => {
      world.version += 1
      return { suggestion: '42' }
    })
    const pending = mountProvider()(fakeToken().token)
    await vi.advanceTimersByTimeAsync(300)

    expect((await pending)?.items).toEqual([])
  })

  it('drops an answer when the focused editor moved its cursor meanwhile', async () => {
    world.cursor = { lineNumber: 1, column: CURSOR_COLUMN }
    run.mockImplementation(async () => {
      world.cursor = { lineNumber: 1, column: 3 }
      return { suggestion: '42' }
    })
    const pending = mountProvider()(fakeToken().token)
    await vi.advanceTimersByTimeAsync(300)

    expect((await pending)?.items).toEqual([])
  })

  it('keeps an answer when the focused editor stayed on the requested position', async () => {
    world.cursor = { lineNumber: 1, column: CURSOR_COLUMN }
    const pending = mountProvider()(fakeToken().token)
    await vi.advanceTimersByTimeAsync(300)

    expect((await pending)?.items).toHaveLength(1)
  })

  it('offers nothing when the plugin answers empty or fails', async () => {
    run.mockResolvedValueOnce({ suggestion: '' }).mockRejectedValueOnce(new Error('boom'))
    const ask = mountProvider()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = ask(fakeToken().token)
      await vi.advanceTimersByTimeAsync(300)
      expect((await pending)?.items).toEqual([])
    }
  })
})
