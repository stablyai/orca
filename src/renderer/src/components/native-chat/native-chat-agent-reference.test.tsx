// @vitest-environment happy-dom

import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { createRef } from 'react'
import { act, cleanup, render, renderHook, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../terminal-pane/pty-transport/pty-transport-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { mountedMention } from './native-chat-agent-reference.test-fixture'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { agentReferenceToken } from '../../../../shared/orchestration-agent-reference'

import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { captureTerminalDropTarget } from '../terminal-pane/input/file-drop/terminal-drop-target'
import { insertTerminalCrewMention } from '../terminal-pane/input/paste/terminal-crew-mention'
import { clearStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'

const crewRows = vi.hoisted(() => new Array<OrchestrationCrewRow>())
vi.mock('./use-orchestration-crew', () => ({
  useOrchestrationCrew: () => ({
    ...emptyCrew('ok'),
    sections: { managedBy: [], managing: crewRows, talkingWith: [] }
  })
}))

// Render the real panel synchronously; the lazy chunk boundary is the app's load detail.
vi.mock('../orchestration-crew/LazyOrchestrationCrewPanel', async () => ({
  LazyOrchestrationCrewPanel: (await import('../orchestration-crew/OrchestrationCrewPanel'))
    .OrchestrationCrewPanel
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: vi.fn() }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => ({ cancel() {}, settleAfterMs: 0 })),
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
afterEach(() => {
  cleanup()
  crewRows.length = 0
  clearNativeChatComposerDraftsForTests()
  clearStructuredAgentSessionPendingSends('test-session')
  vi.restoreAllMocks()
})
const first = { label: 'Same name', address: 'term_first', hostKey: 'local' }

function editor(scope: string, text = 'Hello ') {
  const ref = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatPromptEditor
      scopeKey={scope}
      inputRef={ref}
      initialValue={text}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  return {
    ...view,
    input: ref.current!,
    editor: promptEditor(within(view.container).getByRole('textbox'))
  }
}
function transport(): NativeChatStructuredComposerTransport {
  return {
    capturePresentation: () => () => true,
    send: vi.fn<NativeChatStructuredComposerTransport['send']>(() => 'queued'),
    dispatchCommand: vi.fn<NativeChatStructuredComposerTransport['dispatchCommand']>(async () => ({
      handled: false,
      accepted: false,
      error: null
    })),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'test-session',
    runtimeEnvironmentId: null
  }
}

it('writes only revalidated split bytes, sanitizing controls without Enter and surfacing rejected acceptance', async () => {
  let leaf = 'leaf-left'
  const sendInput = vi.fn(() => true)
  const sendInputAccepted = vi.fn(async () => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mention only reads pane id/leaf, never operates a terminal widget.
  const manager = { getPanes: () => [{ id: 1, leafId: leaf }] } as PaneManager
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing drop validator and writer only consume these four transport methods.
  const pty = {
    getPtyId: () => 'pty-left',
    isConnected: () => true,
    sendInput,
    sendInputAccepted
  } as unknown as PtyTransport
  const target = captureTerminalDropTarget({ id: 1, leafId: leaf }, pty)
  const transports = new Map([[1, pty]])
  expect(
    await insertTerminalCrewMention(manager, transports, target, [
      { ...first, label: 'Zoë\r\n\u001b[31m\u2028\u0085' }
    ])
  ).toBe(true)
  expect(sendInputAccepted).toHaveBeenCalledWith('Zoë  [31m  (Orca agent term_first) ', 'driving')
  expect(sendInput).not.toHaveBeenCalled()
  leaf = 'leaf-replaced'
  expect(await insertTerminalCrewMention(manager, transports, target, [first])).toBe(false)
  expect(sendInputAccepted).toHaveBeenCalledTimes(1)
  leaf = 'leaf-left'
  sendInputAccepted.mockResolvedValueOnce(false)
  expect(await insertTerminalCrewMention(manager, transports, target, [first])).toBe(false)
  expect(sendInputAccepted).toHaveBeenCalledTimes(2)
  expect(
    await insertTerminalCrewMention(manager, transports, target, [
      { ...first, address: 'term_bad\r' }
    ])
  ).toBe(false)
  expect(sendInputAccepted).toHaveBeenCalledTimes(2)
})

it('applies structured UTF-8 admission to the expanded final body before any send slot is taken', async () => {
  const pane = editor('size', '')
  act(() => pane.input.insertAgentReferences!([{ ...first, label: 'é'.repeat(70000) }]))
  const raw = readNativeChatComposerDraft('size')
  expect(Buffer.byteLength(raw.text, 'utf8')).toBeLessThan(256 * 1024)
  const structured = transport()
  structured.dispatchCommand = async () => ({ handled: false, accepted: false, error: null })
  const hook = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: 'size',
      imageAttachments: [],
      structuredTransport: structured,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  await act(async () => hook.result.current(raw.text))
  expect(structured.send).not.toHaveBeenCalled()
  expect(structured.onError).toHaveBeenCalledTimes(1)
  expect(readNativeChatComposerDraft('size').text).toBe(raw.text)
})

it('preserves the exact QA3773 ordinary draft around a native row Mention at caret 14', async () => {
  const user = userEvent.setup()
  const view = mountedMention(crewRows, first, false, 'QA3773 before  after')
  const input = view.input.current!
  act(() => {
    input.focus()
    input.setSelectionRange(14, 14)
  })
  await user.click(view.getByRole('button', { name: /^Show orchestration: 1 worker,/ }))
  await user.click(
    within(view.getByRole('complementary', { name: 'Orchestration' }))
      .getByText(first.label)
      .closest('button')!
  )
  expect(input.value).toBe(`QA3773 before ${agentReferenceToken(first)} after`)
  expect(readNativeChatComposerDraft('menu').document?.content?.[0]?.content).toEqual([
    { type: 'text', text: 'QA3773 before ' },
    { type: 'nativeChatAgentReference', attrs: { ...first, hostKey: 'captured-host' } },
    { type: 'text', text: ' after' }
  ])
  expect(
    view.container
      .querySelector('[data-native-chat-agent-reference]')
      ?.getAttribute('data-native-chat-agent-reference')
  ).toBe(first.address)
  expect(input.selectionStart).toBe(`QA3773 before ${agentReferenceToken(first)}`.length)
  expect(input.contains?.(document.activeElement)).toBe(true)
  expect(view.getByRole('button', { name: 'Collapse orchestration panel' }).isConnected).toBe(true)
})
