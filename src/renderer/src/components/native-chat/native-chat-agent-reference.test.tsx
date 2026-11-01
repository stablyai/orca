// @vitest-environment happy-dom
import { agentReferenceDeliveryText } from '../../../../shared/orchestration-agent-reference.test-fixture'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { nativeChatPastedTextToken } from './native-chat-pasted-text-reference'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { createRef } from 'react'
import { act, cleanup, render, renderHook, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../terminal-pane/pty-transport-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { mountedMention } from './native-chat-agent-reference.test-fixture'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { agentReferenceToken } from '../../../../shared/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from './native-chat-agent-reference-send'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { captureTerminalDropTarget } from '../terminal-pane/terminal-drop-target'
import { insertTerminalCrewMention } from '../terminal-pane/terminal-crew-mention'
import { clearStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'

const crewRows = vi.hoisted(() => new Array<OrchestrationCrewRow>())
vi.mock('./use-orchestration-crew', () => ({
  useOrchestrationCrew: () => ({
    ...emptyCrew('ok'),
    sections: { managedBy: [], managing: crewRows, talkingWith: [] }
  })
}))

vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: vi.fn() }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => ({ cancel() {}, settleAfterMs: 0 })),
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))
afterEach(() => {
  cleanup()
  crewRows.length = 0
  clearNativeChatComposerDraftsForTests()
  clearStructuredAgentSessionPendingSends('test-session')
  vi.restoreAllMocks()
})
const first = { label: 'Same name', address: 'term_first', hostKey: 'local' }
const second = { ...first, address: 'dispatch:ctx_second' }
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

it('keeps a split’s caret, duplicate-name identities, literal unsent copy and atomic undo', async () => {
  const left = editor('left')
  const right = editor('right', 'Other draft')
  await act(async () => {
    left.input.setSelectionRange(6, 6)
    right.input.focus()
    left.input.insertAgentReferences!([first, second])
  })
  const stored = `Hello ${agentReferenceToken(first)} ${agentReferenceToken(second)} `
  expect(left.input.value).toBe(stored)
  expect(right.input.value).toBe('Other draft')
  expect(left.container.querySelectorAll('[data-native-chat-agent-reference]')).toHaveLength(2)
  const doc = readNativeChatComposerDraft('left').document
  expect(serializeNativeChatAgentReferences(stored, doc)).toBe(
    'Hello @Same name (1) @Same name (2) \n\n[Orca agent "Same name (1)": term_first — message it with orca orchestration send --to term_first]\n[Orca agent "Same name (2)": dispatch:ctx_second — message it with orca orchestration send --to dispatch:ctx_second]'
  )
  expect(left.editor.getText()).toBe(stored)
  expect(serializeNativeChatAgentReferences('/model', doc)).toBe('/model')
  await act(async () => {
    left.input.setSelectionRange(6, 6 + agentReferenceToken(first).length)
    left.editor.commands.deleteSelection()
  })
  expect(left.container.querySelectorAll('[data-native-chat-agent-reference]')).toHaveLength(1)
  await act(async () => {
    left.editor.commands.undo()
  })
  expect(left.input.value).toBe(stored)
  await act(async () => {
    left.input.value = 'Old plain @Same name draft'
  })
  expect(left.container.querySelectorAll('[data-native-chat-agent-reference]')).toHaveLength(0)
  expect(
    serializeNativeChatAgentReferences(
      left.input.value,
      readNativeChatComposerDraft('left').document
    )
  ).toBe('Old plain @Same name draft')
})

it('serializes the captured draft before structured and PTY sends', async () => {
  const pane = editor('send')
  act(() => {
    pane.input.setSelectionRange(6, 6)
    pane.input.insertAgentReferences!([first, first, second])
  })
  const fileId = '22222222-2222-4222-8222-222222222222'
  act(() => pane.editor.commands.insertContent(` ${nativeChatPastedTextToken(fileId)}`))
  updateNativeChatComposerDraft(
    'send',
    { pastedTextFiles: { [fileId]: '/tmp/Same name (1).txt' } },
    'immediate'
  )
  const snapshot = readNativeChatComposerDraft('send')
  const wire = serializeNativeChatAgentReferences(
    snapshot.text,
    snapshot.document,
    snapshot.pastedTextFiles
  )
  const structured = transport()
  const structuredHook = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: 'send',
      imageAttachments: [],
      structuredTransport: structured,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  await act(async () => {
    await structuredHook.result.current(snapshot.text)
  })
  expect(wire).toBe(agentReferenceDeliveryText)
  expect(structured.send).toHaveBeenCalledWith(wire, [])
  expect(wire.match(/\[Orca agent/g)).toHaveLength(2)
  updateNativeChatComposerDraft('send', snapshot, 'immediate')
  const optimistic = vi.fn()
  const ptyHook = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent: 'codex',
      draftScopeKey: 'send',
      draft: snapshot.text,
      imageAttachments: [],
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pty-left', settings: null }),
      classifySend: () => 'chat',
      sessionOptionsSurface: null,
      terminalTabId: 'tab-left',
      trackPendingSend: vi.fn(),
      onOptimisticSend: optimistic,
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
  act(() => ptyHook.result.current())
  expect(vi.mocked(sendNativeChatMessage).mock.calls.at(-1)?.slice(0, 2)).toEqual([
    'pty-left',
    wire
  ])
  expect(optimistic).toHaveBeenCalledExactlyOnceWith(wire, [])
})

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

it('captures projected identity once for real typed-goal dispatch and Goal mode', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const token = nativeChatPastedTextToken(id)
  const pane = editor('goals', '/goal Inspect ')
  act(() => {
    pane.input.setSelectionRange(pane.input.value.length, pane.input.value.length)
    pane.input.insertAgentReferences!([first, second, first])
    pane.editor.commands.insertContent(` ${token}`)
  })
  updateNativeChatComposerDraft(
    'goals',
    { pastedTextFiles: { [id]: '/tmp/Same name (1).txt' } },
    'immediate'
  )
  const snapshot = readNativeChatComposerDraft('goals')
  const expected = serializeNativeChatAgentReferences(
    snapshot.text,
    snapshot.document,
    snapshot.pastedTextFiles
  )
    .replace(/^\/goal\s+/, '')
    .trim()
  expect(expected).toContain('@Same name (2) @Same name (3) @Same name (2)')
  const setObjective = vi.fn(async () => true)
  const structured = transport()
  structured.threadGoal = { setObjective }
  structured.dispatchCommand = (text) =>
    dispatchStructuredAgentSessionComposerCommand(text, {
      snapshot: [],
      invokeAction: async () => true,
      setOption: async () => true,
      setThreadGoalObjective: setObjective
    })
  structured.capturePresentation = () => {
    updateNativeChatComposerDraft(
      'goals',
      { text: 'later @label', document: undefined, pastedTextFiles: { [id]: '/tmp/later.txt' } },
      'immediate'
    )
    return () => true
  }
  const hook = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: 'goals',
      imageAttachments: [],
      structuredTransport: structured,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  await act(async () => hook.result.current(snapshot.text))
  expect(setObjective).toHaveBeenLastCalledWith(expected)
  expect(structured.send).not.toHaveBeenCalled()
  updateNativeChatComposerDraft('goals', snapshot, 'immediate')
  const mode = renderHook(() =>
    useNativeChatComposerSubmit({
      structuredTransport: structured,
      draftScopeKey: 'goals',
      draft: snapshot.text,
      caret: 0,
      imageAttachments: [],
      disabled: false,
      sendPty: vi.fn(),
      sendStructured: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  act(() =>
    mode.result.current.goalMode.interceptPick(vi.fn())({
      kind: 'command',
      id: 'goal',
      name: 'goal',
      token: '/goal',
      skillCollision: false
    })
  )
  await act(async () => mode.result.current.send())
  expect(setObjective).toHaveBeenCalledTimes(2)
  expect(setObjective).toHaveBeenLastCalledWith(expected)
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

it('keeps direct, Mention all and real menu Mention on the current native handle, caret and captured host after dismissal', async () => {
  for (const route of ['direct', 'all', 'menu']) {
    const user = userEvent.setup()
    const view = mountedMention(crewRows, first, route === 'all')
    const input = view.input.current!
    act(() => {
      input.focus()
      input.setSelectionRange(6, 6)
    })
    await user.click(view.getByRole('button', { name: 'Show crew: 1 workers' }))
    const more = view.getByRole('button', { name: `More for ${first.label}` })
    const insert = vi.spyOn(view.handle.current!, 'insertAgentReferences')
    if (route === 'menu') {
      await user.click(more)
    }
    const popup = within(document.body).queryByRole('menu')
    const closed = vi.fn()
    popup?.addEventListener('focusScope.autoFocusOnUnmount', closed)
    const returnFocus = vi.spyOn(more, 'focus')
    await user.click(
      route === 'menu'
        ? within(document.body).getByRole('menuitem', { name: 'Mention in message' })
        : route === 'all'
          ? view.getByRole('button', { name: 'Mention all' })
          : view.getByRole('button', { name: new RegExp(`${first.label} No shared task`) })
    )
    expect(insert).toHaveBeenCalledExactlyOnceWith([{ ...first, hostKey: 'captured-host' }])
    expect(insert.mock.results[0]?.value).toBe(true)
    expect(input.contains?.(document.activeElement)).toBe(true)
    expect(view.getByRole('button', { name: 'Collapse crew panel' }).isConnected).toBe(true)
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull())
    if (popup) {
      await waitFor(() => expect(closed).toHaveBeenCalledOnce())
      expect(closed.mock.calls[0][0].target).toBe(popup)
    }
    expect(input.value).toBe(`Hello ${agentReferenceToken(first)} suffix`)
    expect(input.selectionStart).toBe(`Hello ${agentReferenceToken(first)} `.length)
    expect(input.contains?.(document.activeElement)).toBe(true)
    expect(returnFocus).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft('menu').document?.content?.[0]?.content).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'nativeChatAgentReference', attrs: { ...first, hostKey: 'captured-host' } },
      { type: 'text', text: ' suffix' }
    ])
    view.unmount()
    clearNativeChatComposerDraftsForTests()
    crewRows.length = 0
  }
})

it('preserves the exact QA3773 ordinary draft around a native row Mention at caret 14', async () => {
  const user = userEvent.setup()
  const view = mountedMention(crewRows, first, false, 'QA3773 before  after')
  const input = view.input.current!
  act(() => {
    input.focus()
    input.setSelectionRange(14, 14)
  })
  await user.click(view.getByRole('button', { name: 'Show crew: 1 workers' }))
  await user.click(view.getByRole('button', { name: new RegExp(`${first.label} No shared task`) }))
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
  expect(view.getByRole('button', { name: 'Collapse crew panel' }).isConnected).toBe(true)
})
