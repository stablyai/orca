import { projectStructuredItemToNativeChat } from '../../src/shared/structured-agent-session-projection'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, createRef } from 'react'
import { NativeChatPromptEditor } from '@/components/native-chat/NativeChatPromptEditor'
import type { NativeChatComposerInput } from '@/components/native-chat/native-chat-composer-input'
import { NativeChatTextAttachmentOpener } from '@/components/native-chat/NativeChatTextAttachments'
import { NativeChatUserMessageRow } from '@/components/native-chat/NativeChatUserMessageRow'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createChatAttachmentReader } from '@/components/native-chat/native-chat-text-attachment-read'
import { AttachmentTextSource } from '../../src/shared/attachment-text-source'
import { AgentSessionAttachmentStore } from '../../src/main/native-chat/agent-session-attachments/agent-session-attachment-store'
import { sanitizeAgentSessionAttachmentName } from '../../src/shared/agent-session-attachments'
import { formatNativeChatFileReference } from '../../src/shared/agent-image-paste'
import { structuredAgentSessionSendBody } from '../../src/shared/structured-agent-session-send-mutation'
import { deriveNativeChatRowContent } from '../../src/shared/native-chat-row-content'
import {
  changePrompt,
  promptEditor,
  promptValue
} from '@/components/native-chat/native-chat-prompt-editor.test-support'
// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../src/shared/native-chat-types'
import type * as nativeChatAgentProfiles from '../../src/shared/native-chat-agent-profiles'
import type * as RemoteRuntimePtyIdModule from '../../src/shared/remote-runtime/remote-runtime-pty-id'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/native-chat/NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => createElement('div', { 'data-testid': 'composer-actions' })
}))
vi.mock('@/components/native-chat/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('@/store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('../../src/shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('@/components/native-chat/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('@/components/native-chat/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock('@/components/native-chat/claude-model-switch-confirmation', () => ({
  createClaudeModelSwitchConfirmationObserver: vi.fn()
}))
vi.mock('../../src/shared/native-chat-agent-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof nativeChatAgentProfiles>()),
  getVerifiedNativeChatCommands: () => []
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('@/components/native-chat/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('@/components/dictation/dictation-control-events', () => ({
  dispatchDictationControl: vi.fn()
}))

vi.mock('@/components/native-chat/native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => null
}))
vi.mock('@/components/native-chat/native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))
vi.mock('@/components/native-chat/use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
import { NativeChatComposer } from '@/components/native-chat/NativeChatComposer'

const sent = (id: string, text: string): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

const send = vi.fn(() => true)
let paneCounter = 0

/** The real composer, editor and draft store over a chat that already holds `prompts`. */
function renderComposer(prompts: string[]): HTMLElement {
  paneCounter += 1
  render(
    createElement(NativeChatComposer, {
      terminalTabId: `tab-${paneCounter}`,
      paneKey: `tab-${paneCounter}:recall`,
      targetPtyId: null,
      agent: 'codex',
      structuredTransport: {
        capturePresentation: () => () => true,
        send,
        dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
        optionsSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        optionSnapshot: [],
        onError: vi.fn(),
        runtime: 'local',
        sessionId: `session-${paneCounter}`,
        runtimeEnvironmentId: null
      },
      recallSource: { messages: prompts.map((text, index) => sent(`sent-${index}`, text)) }
    })
  )
  return screen.getByRole('textbox')
}

function press(input: HTMLElement, key: 'ArrowUp' | 'ArrowDown'): string {
  fireEvent.keyDown(input, { key })
  return promptValue(input)
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      git: { discoverCommitMessageModels: vi.fn().mockResolvedValue({ success: false }) },
      pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) }
    }
  })
})

afterEach(() => cleanup())

describe('composer prompt recall', () => {
  it('walks prompts sent before this composer existed, and back to an empty draft', () => {
    const input = renderComposer(['one', 'two'])
    expect(press(input, 'ArrowUp')).toBe('two')
    expect(press(input, 'ArrowUp')).toBe('one')
    expect(press(input, 'ArrowDown')).toBe('two')
    expect(press(input, 'ArrowDown')).toBe('')
  })

  // `/model` opens the command picker when typed; recalled, it must not take the arrows.
  it('keeps walking past a recalled command instead of handing the arrows to its picker', () => {
    const input = renderComposer(['one', '/model'])
    expect(press(input, 'ArrowUp')).toBe('/model')
    expect(press(input, 'ArrowUp')).toBe('one')
  })

  it('leaves the arrows alone once a recalled prompt is edited', () => {
    const input = renderComposer(['one', 'two'])
    press(input, 'ArrowUp')
    changePrompt(input, 'two, edited')
    expect(press(input, 'ArrowUp')).toBe('two, edited')
  })
})

it.each([
  ['adjacent prose', 'see'],
  ['existing emphasis', '**see **'],
  ['existing fence', '```text\nsee \n```']
] as const)(
  'keeps exact picked identities through %s insertion, recall, Send, descriptor-less row and owning read',
  async (_label, initialValue) => {
    const folder = await mkdtemp(join(tmpdir(), 'identity35636-'))
    const store = new AgentSessionAttachmentStore(
      join(folder, 'root @\'"', 'agent-session-attachments'),
      { hasSession: () => true }
    )
    Object.assign(window.api, {
      runtime: {
        call: async ({
          method,
          params
        }: {
          method: string
          params: Parameters<typeof store.readTextChunk>[0]
        }) => ({
          id: '35636',
          ok: true,
          result:
            method === 'status.get'
              ? { runtimeId: 'owner35636', capabilities: ['native-chat.text-attachment-read.v1'] }
              : await store.readTextChunk(params)
        })
      }
    })
    const names = [
      'report.csv',
      '_notes_.txt',
      'a&copy;.txt',
      'a©.txt',
      'a`b.txt',
      'a`b`.txt',
      'c`d.txt',
      'a``b``.txt',
      '[log](v1).txt',
      "space @ apostrophe'.txt",
      '日本語🙂.txt',
      `${'x'.repeat(196)}.txt`
    ]
    const paths: string[] = []
    const expected = new Map<string, string>()
    try {
      for (const [index, name] of names.entries()) {
        expect(sanitizeAgentSessionAttachmentName(name)).toBe(name)
        const text = `sentinel35636-${index}\r\n🙂`
        const bytes = Buffer.from(text)
        const { uploadId } = await store.startUpload({
          callerKey: '35636',
          sessionId: 's',
          name,
          byteLength: bytes.length
        })
        await store.appendChunk({
          callerKey: '35636',
          uploadId,
          offset: 0,
          contentBase64: bytes.toString('base64')
        })
        const { path } = await store.commitUpload({ callerKey: '35636', uploadId })
        paths.push(path)
        expected.set(path, text)
        if (name === 'a&copy;.txt') {
          await writeFile(join(path, '..', 'a©.txt'), 'OPPOSITE35636')
        }
        if (name.includes('`')) {
          await writeFile(join(path, '..', 'a'), 'OPPOSITE35636')
        }
      }
      const ref = createRef<NativeChatComposerInput>()
      let value = ''
      const draftPaths: string[] = []
      const draftCopies: Promise<string>[] = []
      const openDraft = vi.fn((path: string) => {
        draftPaths.push(path)
        draftCopies.push(
          new AttachmentTextSource(path, createChatAttachmentReader({ kind: 'local' })).copyText()
        )
      })
      const picked = render(
        createElement(
          NativeChatTextAttachmentOpener.Provider,
          { value: openDraft },
          createElement(NativeChatPromptEditor, {
            scopeKey: 'pick35636',
            inputRef: ref,
            initialValue,
            disabled: false,
            placeholder: 'Message',
            onChange: (current) => {
              value = current.value
            },
            onSelect: () => {}
          })
        )
      )
      act(() => {
        const editor = promptEditor(screen.getByRole('textbox'))
        editor.state.doc.descendants((node, position) => {
          const index = node.isText ? node.text?.indexOf('see') : undefined
          if (index !== undefined && index >= 0) {
            editor.commands.setTextSelection(position + index + 3)
          }
        })
      })
      await act(async () => ref.current!.insertFileReferences!(paths))
      const insertion = initialValue.indexOf('see') + 3
      expect(value).toBe(
        `${initialValue.slice(0, insertion)}${paths.map(formatNativeChatFileReference).join(' ')} ${initialValue.slice(insertion)}`
      )
      for (const name of names) {
        fireEvent.click(screen.getByRole('button', { name }))
      }
      expect(draftPaths).toEqual(paths)
      expect(await Promise.all(draftCopies)).toEqual(paths.map((path) => expected.get(path)))
      const original = value.trimEnd()
      picked.unmount()
      const input = renderComposer([original])
      expect(press(input, 'ArrowUp')).toBe(original)
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(send).toHaveBeenLastCalledWith(original, []))
      expect(structuredAgentSessionSendBody(original, []).blocks).toEqual([
        { type: 'text', text: original }
      ])
      cleanup()
      const message = projectStructuredItemToNativeChat(
        JSON.parse(
          JSON.stringify({
            itemId: 'descriptor-less35636',
            revision: 1,
            sequence: 1,
            observedAt: 1,
            body: {
              kind: 'message',
              role: 'user',
              blocks: structuredAgentSessionSendBody(original, []).blocks
            }
          })
        )
      )!
      expect(message.blocks).toEqual([{ type: 'text', text: original }])
      const derived = deriveNativeChatRowContent(message.blocks)
      const copies: Promise<string>[] = []
      const opened: string[] = []
      const openSent = vi.fn((path: string) => {
        opened.push(path)
        copies.push(
          new AttachmentTextSource(path, createChatAttachmentReader({ kind: 'local' })).copyText()
        )
      })
      render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            NativeChatTextAttachmentOpener.Provider,
            { value: openSent },
            createElement(NativeChatUserMessageRow, {
              message,
              markdown: derived.markdown,
              prose: derived.prose,
              rowRef: createRef<HTMLDivElement>(),
              onRefolded: () => {},
              structuredAttachments: true,
              allowFileUriLinks: false
            })
          )
        )
      )
      for (const name of names) {
        fireEvent.click(screen.getByRole('button', { name }))
      }
      expect(opened).toEqual(paths)
      expect(await Promise.all(copies)).toEqual(paths.map((path) => expected.get(path)))
    } finally {
      cleanup()
      store.clearInFlightForTests()
      await rm(folder, { recursive: true, force: true })
    }
  }
)
