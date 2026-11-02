// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatStructuredSession } from '@/components/native-chat/NativeChatStructuredSession'
import PendingNativeChatCreation from '@/components/worktree-creation/PendingNativeChatCreation'
import {
  changePrompt,
  promptValue
} from '@/components/native-chat/native-chat-prompt-editor.test-support'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import type * as Admission from './agent-session/launch/structured-agent-session-host-admission'
import type * as Launch from './agent-session/launch/structured-agent-session-launch-create-call'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import {
  pendingCreationChatDraftScopeKey,
  type WorktreeCreationRequest
} from './pending-worktree-creation'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (
    await import('../components/native-chat/NativeChatStructuredSession.test-harness')
  ).createStructuredSessionMocks()
)
const host = vi.hoisted(() => ({
  admission: vi.fn<typeof Admission.admitStructuredLaunchOnHost>(),
  createSession: vi.fn<typeof Launch.launchStructuredAgentSession>()
}))
vi.mock('./agent-session/launch/structured-agent-session-host-admission', async (original) => ({
  ...(await original<typeof Admission>()),
  admitStructuredLaunchOnHost: host.admission
}))
vi.mock('./agent-session/launch/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof Launch>()),
  launchStructuredAgentSession: host.createSession
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('../components/native-chat/use-structured-agent-session', () =>
  moduleFactories.useStructuredAgentSession()
)
vi.mock('../components/native-chat/use-native-chat-font-size', () =>
  moduleFactories.useNativeChatFontSize()
)
vi.mock('../components/native-chat/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../components/native-chat/NativeChatMessageList', () =>
  moduleFactories.nativeChatMessageList()
)
vi.mock('../components/native-chat/NativeChatEmptyState', () =>
  moduleFactories.nativeChatEmptyState()
)
vi.mock('../components/worktree-creation/WorktreeSetupSteps', () => ({
  WorktreeSetupSteps: () => null
}))
vi.mock('../components/worktree-creation/WorktreeCreationTabStrip', () => ({
  default: () => null
}))

const initialState = useAppStore.getState()
const worktree = makeCreatedAgentWorktree()
const source = pendingCreationChatDraftScopeKey('creation-1')
const request: WorktreeCreationRequest = {
  repoId: worktree.repoId,
  name: 'feature',
  setupDecision: 'skip',
  agent: 'codex',
  agentLaunchRoute: 'structured-native-chat',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: 'Fix the bug',
  quickTelemetry: null,
  suppressTerminalFocusOnCompletion: true
}
let main: TabsDrawnFromMain

beforeEach(async () => {
  resetStructuredAgentLaunchRegistryForTests()
  seedEmptyActivatableWorktree(worktree)
  useAppStore.setState({
    activeWorktreeId: null,
    activePendingCreationId: 'creation-1',
    pendingWorktreeCreations: {
      'creation-1': {
        creationId: 'creation-1',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    },
    createWorktree: vi.fn().mockResolvedValue({ worktree })
  })
  host.admission.mockResolvedValue({ kind: 'admitted' })
  host.createSession.mockReturnValue(new Promise(() => {}))
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => {
  cleanup()
  main.close()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredSessionMocks()
  clearNativeChatComposerDraftsForTests()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

function prompt(kind: 'approval' | 'question'): AgentJournalRenderItem {
  return {
    itemId: 'prompt-1',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body:
      kind === 'approval'
        ? {
            kind,
            title: 'Run the command?',
            detail: null,
            options: [{ id: 'allow', label: 'Approve' }],
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        : {
            kind,
            question: 'Which approach?',
            options: [{ id: 'default', label: 'Use the default' }],
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
  }
}

it.each([
  { kind: 'approval', draft: '' },
  { kind: 'question', draft: '' },
  { kind: 'approval', draft: 'Unsent follow-up' },
  { kind: 'question', draft: 'Unsent follow-up' }
] as const)('reveals a mounted $kind with draft "$draft"', async ({ kind, draft }) => {
  const pending = render(
    <TooltipProvider>
      <PendingNativeChatCreation creationId="creation-1" />
    </TooltipProvider>
  )
  const field = screen.getByRole('textbox')
  if (draft) {
    changePrompt(field, draft)
    fireEvent.compositionStart(field)
  }
  let completion: Promise<void> = Promise.resolve()
  act(() => {
    completion = executeWorktreeCreation('creation-1', request)
  })
  await waitFor(() => expect(host.createSession).toHaveBeenCalledOnce())
  await main.settle()
  const { sessionId } = host.createSession.mock.calls[0][0]
  const tab = useAppStore.getState().getActiveTab(worktree.id)
  expect(tab?.contentType).toBe('agent-session')
  if (!tab) {
    throw new Error('Created chat tab was not published')
  }
  const destination = structuredAgentSessionDraftScopeKey(sessionId)
  const item = prompt(kind)
  mocks.promptItems = [item]
  mocks.turnId = 'turn-1'
  expect(useAppStore.getState().activePendingCreationId).toBe('creation-1')
  expect(readNativeChatComposerDraft(source).text).toBe(draft)

  const pane = (visible: boolean) => (
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible={visible}
        isFocusedGroup={visible}
        tabId={tab.id}
        sessionId={sessionId}
        target={{ kind: 'local' }}
        agent="codex"
      />
    </TooltipProvider>
  )
  const replacement = render(pane(false))
  await act(async () => {})
  const action = screen.getByRole('button', {
    name: kind === 'approval' ? /Approve/ : /Use the default/
  })
  expect(action.hasAttribute('disabled')).toBe(false)
  if (draft) {
    expect(useAppStore.getState().activePendingCreationId).toBe('creation-1')
    expect(readNativeChatComposerDraft(source).text).toBe(draft)
    expect(readNativeChatComposerDraft(destination).text).toBe('')
    changePrompt(field, `${draft}, finished composing`)
    fireEvent.compositionEnd(field)
  }
  await act(async () => {
    await completion
  })
  expect(useAppStore.getState().activeWorktreeId).toBe(worktree.id)
  expect(useAppStore.getState().activePendingCreationId).toBeNull()
  expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
  expect(readNativeChatComposerDraft(source).text).toBe('')
  const expectedDraft = draft ? `${draft}, finished composing` : ''
  expect(readNativeChatComposerDraft(destination).text).toBe(expectedDraft)

  pending.unmount()
  replacement.rerender(pane(true))
  fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
  expect(mocks.cancel).toHaveBeenCalledWith('turn-1', {
    itemId: item.itemId,
    expectedRevision: item.revision
  })
  // Resolving the prompt restores the retained follow-up to the real destination editor.
  mocks.promptItems = []
  replacement.rerender(pane(true))
  expect(promptValue(screen.getByRole('textbox'))).toBe(expectedDraft)
})
