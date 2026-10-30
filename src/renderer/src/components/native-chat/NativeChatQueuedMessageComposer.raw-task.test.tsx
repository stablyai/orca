// @vitest-environment happy-dom

import {
  done,
  script,
  SESSION,
  SCOPE,
  write,
  writeSpy
} from './structured-queued-edit.test-fixture'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../../../../shared/orca-dispatch-status-prompt'
import { agentSessionSendBodyFingerprint } from '../../../../shared/structured-agent-session-send-mutation'
import { projectQueuedMessageCards } from '../../../../shared/structured-agent-session-queued-cards'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support'
import { render } from './native-chat-tooltip-test-harness'
import { useStructuredAgentSessionQueuedEdit } from './use-structured-agent-session-queued-edit'

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      dictationState: 'idle',
      settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      updateSettings: vi.fn()
    }))
  }
})
// Keep host discovery and OS file intake outside this text-only queued consumer contract.
vi.mock('./use-native-chat-session-options', () => ({
  useNativeChatSessionOptions: () => ({ surface: null, snapshot: [] })
}))
vi.mock('./use-native-chat-mention-files', () => ({
  useNativeChatMentionFiles: () => ({ files: [], loading: false, failed: false })
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: vi.fn() })
}))
vi.mock('./use-native-chat-file-drops', () => ({
  useNativeChatFileDrops: () => ({
    pickAttachments: vi.fn(),
    attachExternalPaths: vi.fn(),
    captureExternalPaths: vi.fn(),
    captureCopiedFiles: vi.fn(),
    resolveAttachmentOwner: () => ({ kind: 'local' })
  })
}))

const transport: NativeChatStructuredComposerTransport = {
  capturePresentation: () => () => true,
  send: vi.fn(() => true),
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
  sessionId: SESSION,
  runtimeEnvironmentId: null
}

function QueuedTask({ message }: { message: AgentSessionQueuedMessage }) {
  const messages = [message]
  const cards = projectQueuedMessageCards(messages, [], {})
  const { editor, begin } = useStructuredAgentSessionQueuedEdit({
    transport: { target: { kind: 'local' }, sessionId: SESSION, capable: true, write },
    messages,
    cards,
    submissions: [],
    composerScopeKey: SCOPE,
    promptOpen: false
  })
  return (
    <ul>
      <NativeChatQueuedMessageCard
        card={cards[0]!}
        chatWorktreeId={null}
        showsSteerShortcut={false}
        onSteer={() => {}}
        onDelete={() => {}}
        onEdit={() => void begin(message.messageId)}
        editor={editor ?? undefined}
        editAttachTo={{ terminalTabId: 'tab', transport }}
      />
    </ul>
  )
}

afterEach(() => vi.restoreAllMocks())

it('shows the queued task and edits, saves and reopens its full raw input in the chat composer', async () => {
  const prefix = `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX} You are a dispatched worker.\n=== TASK ===\n`
  const task = 'Inspect the queued task'
  const changedTask = 'Inspect the edited task'
  const message: AgentSessionQueuedMessage = {
    messageId: 'card',
    position: 1,
    state: 'waiting',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: prefix + task }],
      from: {
        kind: 'agent',
        senders: [],
        orchestration: { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
      }
    }
  }
  // The host's queuedMessageUpdateDecision removes attribution on a content-changing Save.
  const { from: _sender, ...userBody } = message.body
  const saved: AgentSessionQueuedMessage = {
    ...message,
    body: { ...userBody, blocks: [{ type: 'text', text: prefix + changedTask }] }
  }
  script.answer = done({
    status: 'updated',
    messageId: message.messageId,
    fingerprint: agentSessionSendBodyFingerprint(SESSION, saved.body)
  })
  const view = render(<QueuedTask message={message} />)
  expect(screen.getByTitle(task).textContent).toBe(task)
  expect(screen.getByText('From')).toBeDefined()
  expect(screen.getByText('an agent')).toBeDefined()
  expect(screen.queryByText(/You are working inside Orca/)).toBeNull()

  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
  const field = await screen.findByRole('textbox', { name: 'Edit message' })
  await waitFor(() => expect(field.getAttribute('contenteditable')).toBe('true'))
  expect(promptValue(field)).toBe(prefix + task)
  changePrompt(field, prefix + changedTask)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(writeSpy).toHaveBeenCalledOnce())
  expect(writeSpy.mock.calls[0]?.[2]).toMatchObject({
    messageId: 'card',
    text: prefix + changedTask
  })
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())

  view.rerender(<QueuedTask message={saved} />)
  expect(screen.getByTitle(prefix + changedTask, { normalizer: (text) => text }).textContent).toBe(
    prefix + changedTask
  )
  expect(screen.queryByText('From')).toBeNull()
  expect(screen.queryByText('an agent')).toBeNull()
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit message' }))
  const reopened = await screen.findByRole('textbox', { name: 'Edit message' })
  await waitFor(() => expect(reopened.getAttribute('contenteditable')).toBe('true'))
  expect(promptValue(reopened)).toBe(prefix + changedTask)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  expect(writeSpy).toHaveBeenCalledOnce()
  expect(transport.send).not.toHaveBeenCalled()
})
