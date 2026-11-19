import { readNativeChatDraftDocument } from '../../drafts/native-chat-draft-views'
// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { JSONContent } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { AllSelection, NodeSelection, TextSelection, type Selection } from '@tiptap/pm/state'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { updateNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { serializeNativeChatAgentReferences } from '../pickers/native-chat-agent-reference-send'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'

afterEach(cleanup)

function setup(value = '') {
  const inputRef = createRef<NativeChatComposerInput>()
  const onChange = vi.fn()
  const view = render(
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue={value}
      disabled={false}
      placeholder="Message"
      onChange={onChange}
      onSelect={vi.fn()}
    />
  )
  return {
    ...view,
    input: inputRef.current!,
    editor: promptEditor(within(view.container).getByRole('textbox')),
    onChange
  }
}

describe('native chat skill editor', () => {
  it('continues replacing the selected text after a composer handoff', () => {
    const inputRef = createRef<NativeChatComposerInput>()
    const text = 'Hello\nworld'
    updateNativeChatComposerDraft('handoff-selection', { text }, 'immediate', undefined, {
      at: 'selection',
      from: 6,
      to: 11,
      target: 'chat-tab',
      pending: true
    })
    render(
      <NativeChatPromptEditor
        scopeKey="handoff-selection"
        positionTarget="chat-tab"
        inputRef={inputRef}
        initialValue={text}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )

    expect(inputRef.current?.selectionStart).toBe(6)
    expect(inputRef.current?.selectionEnd).toBe(11)
    act(() => inputRef.current?.insertText?.('there'))
    expect(inputRef.current?.value).toBe('Hello\nthere')
  })

  it('shows attached files as filename pills that serialize to the reference the agent reads', async () => {
    const { input, container, onChange } = setup('See  please')
    act(() => input.setSelectionRange(4, 4))
    await act(async () =>
      input.insertFileReferences!(['/Users/abc/Downloads/test (1).csv', 'C:\\docs\\letter.pdf'])
    )
    const pills = [...container.querySelectorAll('[data-native-chat-file-reference]')]
    // What each shows; a screen reader hears "File: …" from hidden text.
    expect(pills.map((pill) => pill.querySelector('.truncate')?.textContent)).toEqual([
      'test (1).csv',
      'letter.pdf'
    ])
    expect(pills[0].querySelector('.sr-only')?.textContent).toBe('File: test (1).csv')
    expect(pills[0].getAttribute('title')).toBe('/Users/abc/Downloads/test (1).csv')
    const references = '@"/Users/abc/Downloads/test (1).csv" @C:\\docs\\letter.pdf '
    expect(input.value).toBe(`See ${references} please`)
    expect(input.selectionStart).toBe(4 + references.length)
    expect(onChange).toHaveBeenCalled()
    const edited = input.value.replace('letter.pdf', 'letter.pd')
    act(() => {
      input.value = edited
    })
    expect(container.querySelectorAll('[data-native-chat-file-reference]')).toHaveLength(1)
    expect(input.value).toBe(edited)
  })

  it('deletes a skill atomically and restores it with undo', async () => {
    const { input, editor, container } = setup('$rev')
    act(() => input.insertSkill!(0, 4, '$review'))
    act(() => {
      input.setSelectionRange(0, 7)
      editor.commands.deleteSelection()
    })
    expect(input.value).toBe(' ')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    await act(async () => {
      editor.commands.undo()
    })
    expect(input.value).toBe('$review ')
    expect(container.querySelector('[data-native-chat-skill]')).not.toBeNull()
  })

  it('reads the current text and caret after edits and undo, separately per editor', async () => {
    const first = setup('one')
    const second = setup('second')
    act(() => first.input.setSelectionRange(3, 3))
    act(() => first.input.insertText!('!'))
    expect(first.input.value).toBe('one!')
    expect(first.input.selectionStart).toBe(4)
    expect(second.input.value).toBe('second')
    await act(async () => {
      first.editor.commands.undo()
    })
    expect(first.input.value).toBe('one')
    expect(first.input.selectionStart).toBe(3)
    expect(second.input.value).toBe('second')
  })

  it('restores selected nodes only in their owning pane draft', async () => {
    const inputRef = createRef<NativeChatComposerInput>()
    const props = {
      inputRef,
      scopeKey: 'pill-pane',
      initialValue: '$rev',
      disabled: false,
      placeholder: 'Message',
      onChange: vi.fn(),
      onSelect: vi.fn()
    }
    const first = render(<NativeChatPromptEditor {...props} />)
    act(() => inputRef.current!.insertSkill!(0, 4, '$review'))
    expect(
      readNativeChatDraftDocument('pill-pane', '$review ')?.content?.[0]?.content?.[0]?.type
    ).toBe('nativeChatSkill')
    first.unmount()
    const second = render(<NativeChatPromptEditor {...props} initialValue="$review " />)
    await waitFor(() =>
      expect(second.container.querySelector('[data-native-chat-skill]')).not.toBeNull()
    )
    second.unmount()
    const other = render(
      <NativeChatPromptEditor {...props} scopeKey="other-pane" initialValue="$review " />
    )
    expect(other.container.querySelector('[data-native-chat-skill]')).toBeNull()
  })

  it.each(['$revision ', '$preview '])(
    'replaces partial skill text with %s without a stale pill',
    (replacement) => {
      const { input, container } = setup('$rev')
      act(() => input.insertSkill!(0, 4, '$review'))
      act(() => {
        input.value = replacement
      })
      expect(input.value).toBe(replacement)
      expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
    }
  )

  it('pastes rich clipboard content as literal text without manufacturing pills', () => {
    const { input, container } = setup()
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        getData: (format: string) =>
          format === 'text/plain'
            ? '$review\nhello'
            : '<span data-native-chat-skill="$review">review</span>'
      }
    })
    expect(input.value).toBe('$review\nhello')
    expect(container.querySelector('[data-native-chat-skill]')).toBeNull()
  })
})

it('replaces the selection with literal pasted text as one undoable edit', async () => {
  const { input, editor } = setup('hello world')
  act(() => input.setSelectionRange(6, 11))
  await act(async () => input.insertText?.('안녕\n$literal'))
  expect(input.value).toBe('hello 안녕\n$literal')
  await act(async () => {
    editor.commands.undo()
  })
  expect(input.value).toBe('hello world')
})

const pill: JSONContent = {
  type: 'nativeChatFileReference',
  attrs: { token: '@src/main.ts', path: '' }
}

it.each<[string, (string | JSONContent)[][], (doc: ProseMirrorNode) => Selection, string, number]>([
  ['at the caret', [['see  please']], (doc) => TextSelection.create(doc, 5), 'see \n please', 5],
  [
    'in place of a selected pill',
    [['see ', pill, ' please']],
    (doc) => NodeSelection.create(doc, 5),
    'see \n please',
    5
  ],
  ['in place of everything', [['abc'], ['def']], (doc) => new AllSelection(doc), '\n', 1],
  [
    'in place of a whole selected line',
    [['abc'], ['def']],
    (doc) => NodeSelection.create(doc, 5),
    'abc\n\n',
    5
  ]
])('starts a new paragraph on Shift+Enter %s', (_name, lines, select, expected, caret) => {
  const { input, editor } = setup()
  act(() => {
    editor.commands.setContent({
      type: 'doc',
      content: lines.map((line) => ({
        type: 'paragraph',
        content: line.map((part) =>
          typeof part === 'string' ? { type: 'text', text: part } : part
        )
      }))
    })
    editor.view.dispatch(editor.state.tr.setSelection(select(editor.state.doc)))
  })
  act(() => {
    fireEvent.keyDown(editor.view.dom, { key: 'Enter', shiftKey: true })
  })
  expect(
    editor
      .getJSON()
      .content?.some((line) => line.content?.some((node) => node.type === 'hardBreak'))
  ).toBe(false)
  expect([input.value, input.selectionStart]).toEqual([expected, caret])
})

function mockMacPlatform(): void {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  onTestFinished(() => {
    userAgent.mockRestore()
    platform.mockRestore()
  })
}

function saveHardBreakDraft(scopeKey: string): string {
  const text = 'abc\ndef\nghi'
  updateNativeChatComposerDraft(
    scopeKey,
    {
      text,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'abc' },
              { type: 'hardBreak' },
              { type: 'text', text: 'def' },
              { type: 'hardBreak' },
              { type: 'text', text: 'ghi' }
            ]
          }
        ]
      }
    },
    'immediate'
  )
  return text
}

it('splits a saved hard-break draft adopted through value into lines without an update', () => {
  const scopeKey = 'hard-break-draft-adopted'
  const inputRef = createRef<NativeChatComposerInput>()
  const onChange = vi.fn()
  const view = render(
    <NativeChatPromptEditor
      scopeKey={scopeKey}
      inputRef={inputRef}
      initialValue=""
      disabled={false}
      placeholder="Message"
      onChange={onChange}
      onSelect={vi.fn()}
    />
  )
  const editor = promptEditor(within(view.container).getByRole('textbox'))
  const text = saveHardBreakDraft(scopeKey)
  act(() => {
    inputRef.current!.value = text
  })
  expect(editor.getJSON().content?.map((line) => line.content?.map((node) => node.type))).toEqual([
    ['text'],
    ['text'],
    ['text']
  ])
  expect([inputRef.current!.value, onChange.mock.calls.length]).toEqual([text, 0])
})

it.each([
  ['a', 4],
  ['e', 7]
])(
  'moves Ctrl-%s on macOS to the edge of the caret line in a saved hard-break draft',
  (key, offset) => {
    mockMacPlatform()
    const scopeKey = `hard-break-draft-${key}`
    const text = saveHardBreakDraft(scopeKey)
    const inputRef = createRef<NativeChatComposerInput>()
    const view = render(
      <NativeChatPromptEditor
        scopeKey={scopeKey}
        inputRef={inputRef}
        initialValue={text}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    )
    const editor = promptEditor(within(view.container).getByRole('textbox'))
    const input = inputRef.current!
    input.setSelectionRange(6, 6)
    act(() => {
      fireEvent.keyDown(editor.view.dom, { key, ctrlKey: true })
    })
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual([text, offset, offset])
  }
)

it.each([
  ['a', 4],
  ['e', 7]
])('moves Ctrl-%s on macOS to the edge of the caret line after a rich-text drop', (key, offset) => {
  mockMacPlatform()
  const { input, editor } = setup()
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 })
  act(() => {
    fireEvent.drop(editor.view.dom, {
      dataTransfer: {
        types: ['text/html', 'text/plain'],
        getData: (format: string) =>
          format === 'text/html' ? '<p>abc<br>def<br>ghi</p>' : 'abc\ndef\nghi'
      }
    })
  })
  expect(editor.getJSON().content?.map((line) => line.content?.map((node) => node.type))).toEqual([
    ['text'],
    ['text'],
    ['text']
  ])
  act(() => input.setSelectionRange(6, 6))
  act(() => {
    fireEvent.keyDown(editor.view.dom, { key, ctrlKey: true })
  })
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual([
    'abc\ndef\nghi',
    offset,
    offset
  ])
})

it('sends an agent mentioned at the end of a non-final line without a space before the newline', () => {
  const { input, editor } = setup('abc\ndef')
  act(() => input.setSelectionRange(3, 3))
  act(() => input.insertAgentReferences?.([{ label: 'Agent', address: 'term_agent', hostKey: '' }]))
  expect(serializeNativeChatAgentReferences(input.value, editor.getJSON())).toMatch(
    /^abc@Agent\ndef/
  )
})

it('turns spellcheck and autocorrect off and back on as the setting changes', () => {
  const settings = useAppStore.getState().settings
  onTestFinished(() => useAppStore.setState({ settings }))
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), nativeChatComposerSpellcheck: false }
  })
  const root = setup().editor.view.dom
  expect(root.getAttribute('spellcheck')).toBe('false')
  expect(root.getAttribute('autocorrect')).toBe('off')
  act(() =>
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), nativeChatComposerSpellcheck: true }
    })
  )
  expect(root.getAttribute('spellcheck')).toBe('true')
  expect(root.getAttribute('autocorrect')).toBeNull()
})
