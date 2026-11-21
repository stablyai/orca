// @vitest-environment happy-dom
import { Activity, createRef, StrictMode } from 'react'
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import {
  NativeChatComposerEditorOwner,
  releaseNativeChatComposerEditors
} from './native-chat-composer-editor-owner'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  openNativeChatEditDraft,
  readNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import {
  closeNativeChatEditDraft,
  installNativeChatDraftRecord,
  redirectNativeChatEditDraft
} from '../../drafts/native-chat-composer-draft-memory'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { mountedEditorView } from './native-chat-mounted-editor-view'
import { openNativeChatViewTabs } from '../../pane/ownership/native-chat-view-memory'

const RELEASED_TAB = { tabId: 'released-tab', worktreeId: 'wt-released' }
openNativeChatViewTabs([RELEASED_TAB.tabId])

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('keeps the draft, selection and undo across hides without a hidden view, and frees the editor when its tab closes', async () => {
  vi.useFakeTimers()
  const input = createRef<NativeChatComposerInput>()
  const pane = (visible: boolean) => (
    <StrictMode>
      <NativeChatComposerEditorOwner>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <NativeChatPromptEditor
            scopeKey="agent-session:retained-editor"
            inputRef={input}
            initialValue="hello"
            disabled={false}
            placeholder="Message"
            onChange={() => {}}
            onSelect={() => {}}
          />
        </Activity>
      </NativeChatComposerEditorOwner>
    </StrictMode>
  )
  const view = render(pane(true))
  const editor = promptEditor(within(view.container).getByRole('textbox'))
  const onDestroy = vi.fn()
  editor.on('destroy', onDestroy)
  act(() => {
    input.current!.setSelectionRange(5, 5)
    input.current!.insertText!(' world')
    input.current!.setSelectionRange(2, 4)
  })
  view.rerender(pane(false))
  await act(() => vi.runOnlyPendingTimersAsync())
  // A hidden composer keeps no view, so none of its document listeners run while other chats are typed in.
  expect(mountedEditorView(editor)).toBeNull()
  expect(onDestroy).not.toHaveBeenCalled()
  view.rerender(pane(true))
  expect(input.current!.value).toBe('hello world')
  expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([2, 4])
  act(() => {
    promptEditor(within(view.container).getByRole('textbox')).commands.undo()
  })
  expect(input.current!.value).toBe('hello')
  view.rerender(pane(false))
  view.unmount()
  await act(() => vi.runOnlyPendingTimersAsync())
  expect(onDestroy).toHaveBeenCalledOnce()
  expect(mountedEditorView(editor)).toBeNull()
})

it('keeps a draft editor with its undo across a released chat view, and frees it when the tab closes', async () => {
  vi.useFakeTimers()
  const input = createRef<NativeChatComposerInput>()
  const pane = () => (
    <NativeChatComposerEditorOwner viewTab={RELEASED_TAB}>
      <NativeChatPromptEditor
        scopeKey="agent-session:released-editor"
        inputRef={input}
        initialValue="hello"
        disabled={false}
        placeholder="Message"
        onChange={() => {}}
        onSelect={() => {}}
      />
    </NativeChatComposerEditorOwner>
  )
  const first = render(pane())
  const editor = promptEditor(within(first.container).getByRole('textbox'))
  act(() => {
    input.current!.setSelectionRange(5, 5)
    input.current!.insertText!(' world')
  })
  first.unmount()
  await act(() => vi.runOnlyPendingTimersAsync())
  const second = render(pane())
  expect(promptEditor(within(second.container).getByRole('textbox'))).toBe(editor)
  act(() => {
    editor.commands.undo()
  })
  expect(input.current!.value).toBe('hello')
  second.unmount()
  await act(() => vi.runOnlyPendingTimersAsync())
  const onDestroy = vi.fn()
  editor.on('destroy', onDestroy)
  releaseNativeChatComposerEditors(['released-tab'])
  expect(onDestroy).toHaveBeenCalledOnce()
})

it('releases completed inline-edit editors while the chat stays open', () => {
  const input = createRef<NativeChatComposerInput>()
  const pane = (scope: string) => (
    <NativeChatComposerEditorOwner>
      <NativeChatPromptEditor
        scopeKey={scope}
        inputRef={input}
        initialValue="queued text"
        disabled={false}
        placeholder="Message"
        onChange={() => {}}
        onSelect={() => {}}
      />
    </NativeChatComposerEditorOwner>
  )
  const view = render(<NativeChatComposerEditorOwner>{null}</NativeChatComposerEditorOwner>)
  for (let index = 0; index < 3; index++) {
    const scope = `queued-edit:retention-${index}`
    openNativeChatEditDraft(scope, { text: 'queued text', images: [] })
    view.rerender(pane(scope))
    const editor = promptEditor(within(view.container).getByRole('textbox'))
    act(() => {
      redirectNativeChatEditDraft(scope, 'agent-session:retained-editor')
      closeNativeChatEditDraft(scope)
    })
    expect(editor.isDestroyed).toBe(true)
  }
  view.unmount()
})

it('restores a deleted pasted-text file with undo after the composer remounts', () => {
  const scope = 'queued-edit:retained-paste'
  const id = '00000000-0000-0000-0000-000000000001'
  const token = '[Pasted text](orca-paste:00000000-0000-0000-0000-000000000001)'
  openNativeChatEditDraft(scope, {
    text: token,
    images: [],
    pastedTextFiles: { [id]: '/workspace/paste.txt' }
  })
  const input = createRef<NativeChatComposerInput>()
  const pane = (shown: boolean) => (
    <NativeChatComposerEditorOwner>
      {shown && (
        <NativeChatPromptEditor
          scopeKey={scope}
          inputRef={input}
          initialValue={token}
          disabled={false}
          placeholder="Message"
          onChange={() => {}}
          onSelect={() => {}}
        />
      )}
    </NativeChatComposerEditorOwner>
  )
  const view = render(pane(true))
  act(() => {
    promptEditor(within(view.container).getByRole('textbox')).commands.selectAll()
    promptEditor(within(view.container).getByRole('textbox')).commands.deleteSelection()
  })
  expect(readNativeChatComposerDraft(scope).pastedTextFiles).toBeUndefined()
  view.rerender(pane(false))
  view.rerender(pane(true))
  act(() => {
    promptEditor(within(view.container).getByRole('textbox')).commands.undo()
  })
  expect(readNativeChatComposerDraft(scope).text).toBe(token)
  expect(readNativeChatComposerDraft(scope).pastedTextFiles).toEqual({
    '00000000-0000-0000-0000-000000000001': '/workspace/paste.txt'
  })
  view.unmount()
  closeNativeChatEditDraft(scope)
})

it('keeps a user selection in a loaded draft when the composer is replaced', () => {
  const scope = 'agent-session:retained-loaded-selection'
  installNativeChatDraftRecord(
    scope,
    { text: 'hello', images: [], savedAt: 1 },
    { at: 'start', pending: true }
  )
  const input = createRef<NativeChatComposerInput>()
  const pane = (shown: boolean) => (
    <NativeChatComposerEditorOwner>
      {shown && (
        <NativeChatPromptEditor
          scopeKey={scope}
          inputRef={input}
          initialValue="hello"
          disabled={false}
          placeholder="Message"
          onChange={() => {}}
          onSelect={() => {}}
        />
      )}
    </NativeChatComposerEditorOwner>
  )
  const view = render(pane(true))
  act(() => input.current!.setSelectionRange(1, 5))
  view.rerender(pane(false))
  view.rerender(pane(true))
  act(() => input.current!.insertText!('X'))
  expect(input.current!.value).toBe('hX')
})
