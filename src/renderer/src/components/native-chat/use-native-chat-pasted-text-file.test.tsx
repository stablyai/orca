// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import {
  clearNativeChatComposerDraftsForTests,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'
import {
  nativeChatPastedTextOperations,
  nativeChatPastedTextToken
} from './native-chat-pasted-text-reference'
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { connectedRuntimeStatus } from '@/runtime/paired-runtime-environment-test-fixture'
import { imageReferenceToken } from '../../../../shared/native-chat-image-reference'

const save = vi.fn(() => new Promise<string>(() => {}))
const notice = vi.fn()
let paste: (text: string) => boolean
const SCOPE = 'agent-session:sizing'
const ID = '00000000-0000-4000-8000-000000000000'
beforeEach(() => {
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  vi.stubGlobal('api', { ui: { savePastedTextAsFile: save } })
})
const remoteOwner: NativeChatAttachmentOwner = {
  kind: 'runtime-session',
  environmentId: 'e1',
  sessionId: 's1',
  pairingRevision: 7
}
function Composer({
  text,
  goal = false,
  filePastes = true,
  owner = remoteOwner
}: {
  text: string
  goal?: boolean
  filePastes?: boolean
  owner?: NativeChatAttachmentOwner
}) {
  const input = useRef<NativeChatComposerInput>(null)
  paste = useNativeChatPastedTextFile({
    scopeKey: SCOPE,
    pastesInline: () => goal,
    editor: () => input.current,
    filePastes,
    resolveAttachmentOwner: () => owner,
    insertTypedText: (value) => insertNativeChatPastedText(input.current, value),
    setNotice: notice
  })
  return (
    <NativeChatPromptEditor
      scopeKey={SCOPE}
      inputRef={input}
      initialValue={text}
      disabled={false}
      placeholder="Message"
      onChange={() => {}}
      onSelect={() => {}}
    />
  )
}
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  nativeChatPastedTextOperations.clear()
  vi.clearAllMocks()
})
it.each([
  { draft: '', text: 'small paste', refused: false },
  { draft: 'a'.repeat(200 * 1024), text: '"'.repeat(30 * 1024), refused: true },
  {
    draft: 'z'.repeat(240 * 1024),
    text: 'q'.repeat(50 * 1024),
    replace: 200 * 1024,
    refused: true
  },
  { draft: '', text: 'é'.repeat(16 * 1024 + 1), refused: true },
  { draft: '', text: 'g'.repeat(270 * 1024), goal: true, refused: true },
  { draft: '', text: "$& $$ $` $'".repeat(4000), refused: true },
  { draft: '', text: 'c'.repeat(20 * 1024), image: 'p'.repeat(240 * 1024), refused: true },
  {
    draft: nativeChatPastedTextToken(ID),
    text: 'q',
    path: `/p/${'a'.repeat(256 * 1024 - 32)}`,
    refused: true
  }
])(
  'respects inline and JSON/UTF-8 send limits, including selection and path bytes',
  ({ draft, text, replace = 0, image = '', path = '', goal = false, refused }) => {
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
    vi.stubGlobal('api', { ui: { savePastedTextAsFile: save } })
    updateNativeChatComposerDraft(
      SCOPE,
      {
        text: draft,
        images: image ? [{ id: 'i1', path: image }] : [],
        pastedTextFiles: path ? { [ID]: path } : {}
      },
      'immediate'
    )
    const view = render(<Composer text={draft} goal={goal} />)
    const editor = promptEditor(view.getByRole('textbox'))
    act(() => {
      if (replace) {
        editor.commands.setTextSelection({ from: 1, to: replace + 1 })
      } else {
        editor.commands.focus('end')
      }
    })
    const input = promptValue(view.getByRole('textbox'))
    const candidate = replace ? text + input.slice(replace) : input + text
    const projected = path
      ? candidate.replace(nativeChatPastedTextToken(ID), () => `@${path} `)
      : candidate
    const body = structuredAgentSessionSendBody(
      imageReferencesToPromptMarkers(projected, ['i1']),
      image ? [{ path: image, previewUri: '' }] : []
    )
    const tooLarge = structuredAgentSessionBlocksTooLarge(body.blocks)
    expect(tooLarge).toBe(Buffer.byteLength(JSON.stringify(body.blocks), 'utf8') > 256 * 1024)
    act(() => void paste(text))
    expect(promptValue(view.getByRole('textbox'))).toBe(refused ? input : candidate)
    expect(save).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledTimes(refused ? 1 : 0)
  }
)

const TOO_LARGE_NOTICE = 'This paste is too large to edit inline. Paste a smaller section.'
const CONNECTING_NOTICE = 'Orca is still connecting to this server. Try pasting again in a moment.'
const LONG_LINE_NOTICE =
  'This paste has a line that is too long to edit. Add line breaks, or paste a smaller section.'

it.each([
  { goal: true, filePastes: true, text: 'x'.repeat(1024 * 1024), message: TOO_LARGE_NOTICE },
  { goal: false, filePastes: false, text: 'x'.repeat(1024 * 1024), message: TOO_LARGE_NOTICE },
  {
    goal: false,
    filePastes: true,
    text: '{"log":1}\r\n'.repeat(100000),
    message: CONNECTING_NOTICE
  },
  { goal: true, filePastes: true, text: '{"log":1}\r\n'.repeat(100000), message: TOO_LARGE_NOTICE }
])(
  'refuses an unattachable large paste before changing the document (goal=$goal, files=$filePastes)',
  (options) => {
    const view = render(
      <Composer text="keep this draft" goal={options.goal} filePastes={options.filePastes} />
    )
    const field = view.getByRole('textbox')
    const editor = promptEditor(field)
    act(() => editor.commands.setTextSelection({ from: 6, to: 10 }))
    const selection = editor.state.selection.toJSON()
    const document = editor.getJSON()
    act(() => expect(paste(options.text)).toBe(true))
    expect(editor.getJSON()).toEqual(document)
    expect(editor.state.selection.toJSON()).toEqual(selection)
    expect(notice).toHaveBeenCalledWith(options.message)
    expect(save).not.toHaveBeenCalled()
    act(() => expect(editor.commands.undo()).toBe(false))
  }
)

it('refuses a too-long pasted line but permits replacing the draft with a smaller CRLF paste', () => {
  const view = render(<Composer text={'é'.repeat(16000)} goal />)
  const field = view.getByRole('textbox')
  const editor = promptEditor(field)
  act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1))
  act(() => paste('é'.repeat(20000)))
  expect(promptValue(field)).toBe('é'.repeat(16000))
  expect(notice).toHaveBeenCalledOnce()
  act(() => editor.commands.selectAll())
  act(() => paste('log\r\n{"small": true}'))
  expect(promptValue(field)).toBe('log\r\n{"small": true}')
  act(() => editor.commands.undo())
  expect(promptValue(field)).toBe('é'.repeat(16000))
  expect(save).not.toHaveBeenCalled()
})

it('keeps overlapping large pastes as separate files, with their raw tokens and undo history', async () => {
  const first = Promise.withResolvers<string>()
  const second = Promise.withResolvers<string>()
  save.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const view = render(<Composer text="before selected after" owner={{ kind: 'local' }} />)
  const field = view.getByRole('textbox')
  const editor = promptEditor(field)
  act(() => editor.commands.setTextSelection({ from: 8, to: 16 }))
  const firstText = `{"log":1}\r\n${nativeChatPastedTextToken(ID)}${'x'.repeat(32768)}`
  const secondText = imageReferenceToken('original') + 'z'.repeat(32768)
  act(() => paste(firstText))
  act(() => paste(secondText))
  expect(save.mock.calls).toEqual([[{ text: firstText }], [{ text: secondText }]])
  expect(editor.state.doc.childCount).toBe(1)
  expect(
    editor.getJSON().content?.[0].content?.filter((node) => node.type === 'nativeChatFileReference')
  ).toHaveLength(2)
  await act(async () => second.resolve('/p/second.txt'))
  await act(async () => first.resolve('/p/first.txt'))
  expect(resolveNativeChatPastedText(SCOPE, promptValue(field))).toBe(
    'before @/p/first.txt @/p/second.txt after'
  )
  act(() => editor.commands.undo())
  expect(resolveNativeChatPastedText(SCOPE, promptValue(field))).toBe('before @/p/first.txt after')
  act(() => editor.commands.undo())
  expect(promptValue(field)).toBe('before selected after')
  expect(notice).not.toHaveBeenCalled()
})

it('uploads a large paste to the paired host instead of inserting it inline', async () => {
  const entry = connectedRuntimeStatus('host-process', 1)
  if (!entry.status) {
    throw new Error('Expected a connected host')
  }
  entry.status.capabilities = ['agent-session.attachments.v1']
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['e1', entry]]) })
  save.mockResolvedValueOnce('/srv/paste.txt')
  const view = render(<Composer text="prefix " />)
  const field = view.getByRole('textbox')
  act(() => promptEditor(field).commands.focus('end'))
  const text = '{"entry": 1}\r\n'.repeat(100000)
  await act(async () => paste(text))
  expect(save).toHaveBeenCalledWith({
    text,
    runtimeEnvironmentId: 'e1',
    agentSessionAttachment: {
      environmentId: 'e1',
      sessionId: 's1',
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'host-process'
    }
  })
  expect(resolveNativeChatPastedText(SCOPE, promptValue(field))).toBe('prefix @/srv/paste.txt')
  expect(promptEditor(field).state.doc.childCount).toBe(1)
  expect(notice).not.toHaveBeenCalled()
})

function lines(count: number, line = 'log line number one two three four'): string {
  return `${line}\n`.repeat(count)
}

it.each([false, true])(
  'inserts a one-character paste into a long existing line (goal=%s)',
  (goal) => {
    const view = render(
      <Composer text={'a'.repeat(40 * 1024)} goal={goal} owner={{ kind: 'local' }} />
    )
    const field = view.getByRole('textbox')
    act(() => promptEditor(field).commands.focus('end'))
    act(() => void paste('x'))
    // The line was already long: only the pasted text decides whether a file or a refusal is needed.
    expect(promptValue(field)).toBe(`${'a'.repeat(40 * 1024)}x`)
    expect(save).not.toHaveBeenCalled()
    expect(notice).not.toHaveBeenCalled()
  }
)

it.each([
  { name: 'goal mode', goal: true, filePastes: true },
  { name: 'a chat without file pastes', goal: false, filePastes: false }
])('inserts a large multi-line paste inline in $name', ({ goal, filePastes }) => {
  const view = render(<Composer text="" goal={goal} filePastes={filePastes} owner={remoteOwner} />)
  const field = view.getByRole('textbox')
  act(() => promptEditor(field).commands.focus('end'))
  const text = lines(2500)
  act(() => void paste(text))
  expect(promptValue(field)).toBe(text)
  expect(save).not.toHaveBeenCalled()
  expect(notice).not.toHaveBeenCalled()
})

it('inserts a large multi-line paste inline when the paired host cannot receive files', () => {
  const entry = connectedRuntimeStatus('host-process', 1)
  if (!entry.status) {
    throw new Error('Expected a connected host')
  }
  entry.status.capabilities = []
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['e1', entry]]) })
  const view = render(<Composer text="" />)
  const field = view.getByRole('textbox')
  act(() => promptEditor(field).commands.focus('end'))
  const text = lines(2500)
  act(() => void paste(text))
  expect(promptValue(field)).toBe(text)
  expect(save).not.toHaveBeenCalled()
  expect(notice).not.toHaveBeenCalled()
})

it('says the paired host is connecting only while its status is unknown', () => {
  const view = render(<Composer text="" />)
  const field = view.getByRole('textbox')
  act(() => promptEditor(field).commands.focus('end'))
  act(() => void paste('x'.repeat(40 * 1024)))
  expect(notice).toHaveBeenLastCalledWith(CONNECTING_NOTICE)
  const entry = connectedRuntimeStatus('host-process', 1)
  entry.status!.capabilities = []
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['e1', entry]]) })
  act(() => void paste('x'.repeat(40 * 1024)))
  expect(notice).toHaveBeenLastCalledWith(LONG_LINE_NOTICE)
  expect(promptValue(field)).toBe('')
})

it.each([
  { name: 'at the line limit', text: 'y'.repeat(16 * 1024), refused: false },
  { name: 'one over the line limit', text: 'y'.repeat(16 * 1024 + 1), refused: true },
  { name: 'a long line after short ones', text: `a\n${'y'.repeat(20000)}`, refused: true },
  {
    name: 'with a bare carriage return',
    text: `${'y'.repeat(10000)}\r${'z'.repeat(10000)}`,
    refused: false
  },
  {
    name: 'with CRLF line ends',
    text: `${'y'.repeat(10000)}\r\n${'z'.repeat(10000)}`,
    refused: false
  },
  { name: 'over the size limit in short lines', text: lines(8000), refused: true }
])('bounds the pasted lines in goal mode: $name', ({ text, refused }) => {
  const view = render(<Composer text="draft " goal owner={{ kind: 'local' }} />)
  const field = view.getByRole('textbox')
  act(() => promptEditor(field).commands.focus('end'))
  act(() => void paste(text))
  expect(notice).toHaveBeenCalledTimes(refused ? 1 : 0)
  expect(promptValue(field)).toBe(refused ? 'draft ' : `draft ${text}`)
})

it('stores a single line too long to edit as a file, though it is under the size threshold', async () => {
  save.mockResolvedValueOnce('/tmp/line.txt')
  const view = render(<Composer text="" owner={{ kind: 'local' }} />)
  const field = view.getByRole('textbox')
  act(() => promptEditor(field).commands.focus('end'))
  const line = 'x'.repeat(20000)
  await act(async () => void paste(line))
  expect(save).toHaveBeenCalledWith({ text: line })
  expect(resolveNativeChatPastedText(SCOPE, promptValue(field))).toBe('@/tmp/line.txt')
  expect(notice).not.toHaveBeenCalled()
})

it('stores a long paste as a file in a local chat and keeps a small one inline', async () => {
  save.mockResolvedValueOnce('/tmp/pasted.txt')
  const view = render(<Composer text="" owner={{ kind: 'local' }} />)
  const field = view.getByRole('textbox')
  act(() => promptEditor(field).commands.focus('end'))
  act(() => void paste('short'))
  await act(async () => void paste(lines(2000)))
  expect(save).toHaveBeenCalledTimes(1)
  expect(resolveNativeChatPastedText(SCOPE, promptValue(field))).toBe('short @/tmp/pasted.txt')
  expect(notice).not.toHaveBeenCalled()
})
