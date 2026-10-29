// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
import { imageReferencesToPromptMarkers } from '../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import { structuredAgentSessionBlocksTooLarge } from '../../../../shared/rpc-contract/structured-agent-session-message-params'

const save = vi.fn(() => new Promise<string>(() => {}))
const notice = vi.fn()
let paste: (text: string) => boolean
const SCOPE = 'agent-session:sizing'
const ID = '00000000-0000-4000-8000-000000000000'
function Composer({ text }: { text: string }) {
  const input = useRef<NativeChatComposerInput>(null)
  paste = useNativeChatPastedTextFile({
    scopeKey: SCOPE,
    scopeEditor: () => input.current,
    resolveAttachmentOwner: () => ({
      kind: 'runtime-session',
      environmentId: 'e1',
      sessionId: 's1',
      pairingRevision: 7
    }),
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
  { draft: 'a'.repeat(200 * 1024), text: '"'.repeat(30 * 1024) },
  { draft: 'z'.repeat(240 * 1024), text: 'q'.repeat(50 * 1024), replace: 200 * 1024 },
  { draft: '', text: 'é'.repeat(16 * 1024 + 1) },
  { draft: '', text: "$& $$ $` $'".repeat(4000) },
  { draft: '', text: 'c'.repeat(20 * 1024), image: 'p'.repeat(240 * 1024) },
  {
    draft: nativeChatPastedTextToken(ID),
    text: 'q',
    path: `/p/${'a'.repeat(256 * 1024 - 32)}`
  }
])(
  'matches the actual JSON/UTF-8 send body, including selection and path bytes',
  ({ draft, text, replace = 0, image = '', path = '' }) => {
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
    const view = render(<Composer text={draft} />)
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
    expect(promptValue(view.getByRole('textbox'))).toBe(tooLarge ? input : candidate)
    expect(save).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledTimes(tooLarge ? 1 : 0)
  }
)
