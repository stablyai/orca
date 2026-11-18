// @vitest-environment happy-dom

// A Suggestion's Start, through the real Suggestions UI, openBotHomeTab, draft cache, focus request
// and Home's composer; only the host RPC, workspace activation and the composer's own heavy
// collaborators are stubbed.
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NativeI18n from '@/i18n/i18n'
import type * as DictationControlEvents from '@/components/dictation/dictation-control-events'
import type * as nativeChatAgentProfiles from '../../../../shared/native-chat/input/commands/native-chat-agent-profiles'
import type * as RemoteRuntimePtyIdModule from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { BotUpNext } from '../../../../shared/bots/bot-look-around'
import type { Bot } from '../../../../shared/bot-types'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  activateHome: vi.fn(() => ({ primaryTabId: null })),
  activateHomeTab: vi.fn(),
  activateHomeTabHere: vi.fn((): boolean => true),
  fetchFolderWorkspaces: vi.fn(async () => {})
}))

vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<typeof NativeI18n>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/store', () => {
  const state = {
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: acceptedAgentStatuses(),
    structuredSessionLaunchDirectoryByTabId: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn(),
    fetchFolderWorkspaces: mocks.fetchFolderWorkspaces,
    setRightSidebarTab: vi.fn(),
    setRightSidebarOpen: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  useAppStore.subscribe = () => () => {}
  return { useAppStore }
})
// The host: Start returns the suggestion's request, and Home's chat is `home-chat`.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateHome
}))
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateHomeTabHere,
  activateStructuredAgentSessionTabOnOwner: mocks.activateHomeTab
}))
vi.mock('@/lib/bot-up-next-unseen', () => ({ markBotUpNextSeen: vi.fn(async () => {}) }))
vi.mock('@/components/native-chat/composer/controls/NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))
vi.mock('@/components/native-chat/composer/pickers/NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('@/components/native-chat/session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendNativeChatMessageVerified: vi.fn(),
  typeNativeChatCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('@/components/native-chat/session/terminal/send/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn()
}))
vi.mock(
  '@/components/native-chat/session/options/terminal/claude-model-switch-confirmation',
  () => ({ createClaudeModelSwitchConfirmationObserver: vi.fn() })
)
vi.mock(
  '../../../../shared/native-chat/input/commands/native-chat-agent-profiles',
  async (importOriginal) => ({
    ...(await importOriginal<typeof nativeChatAgentProfiles>()),
    getVerifiedNativeChatCommands: () => []
  })
)
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('@/components/native-chat/composer/pickers/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('@/components/dictation/dictation-control-events', async (importOriginal) => ({
  ...(await importOriginal<typeof DictationControlEvents>()),
  dispatchDictationControl: vi.fn()
}))

import { BotUpNextSection } from './BotUpNextSection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposer } from '@/components/native-chat/composer/NativeChatComposer'
import type { NativeChatComposerHandle } from '@/components/native-chat/composer/native-chat-composer-types'
import { useNativeChatRootInputRouting } from '@/components/native-chat/composer/focus/use-native-chat-root-input-routing'
import { promptValue } from '@/components/native-chat/composer/editor/native-chat-prompt-editor.test-support'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'

const HOME_CHAT = 'home-chat'
const bot: Bot = {
  id: 'b1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: HOME_CHAT,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const ASK = 'Answer Bob’s comments on stablyai/orca#1234.'
const upNext: BotUpNext = {
  state: { running: false, lastLookedAt: Date.UTC(2026, 9, 31, 16, 4), seenAt: 1 },
  items: [
    {
      id: 's1',
      title: 'Answer Bob’s review comments on PR #1234',
      why: 'Bob requested changes this morning.',
      ask: ASK,
      link: 'https://github.com/stablyai/orca/pull/1234',
      source: 'github',
      createdAt: 1
    }
  ]
}

type HomeView = 'not-open' | 'background' | 'showing'
let homeView: HomeView = 'showing'
const homeViewListeners = new Set<() => void>()
function setHomeView(view: HomeView): void {
  homeView = view
  for (const listener of homeViewListeners) {
    listener()
  }
}
function subscribeHomeView(listener: () => void): () => void {
  homeViewListeners.add(listener)
  return () => homeViewListeners.delete(listener)
}

/** Home's chat as its pane holds it: the real composer behind the pane's focus routing. */
function HomeChatPane({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const tabId = structuredAgentSessionTabId(HOME_CHAT)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const questionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
  const routing = useNativeChatRootInputRouting({
    tabId,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible,
    isFocusedGroup: true,
    composerReady: true
  })
  return (
    <div ref={rootRef} tabIndex={-1} hidden={!isVisible} {...routing}>
      <NativeChatComposer
        ref={composerRef}
        terminalTabId={tabId}
        paneKey={`${tabId}:leaf`}
        draftScopeKey={structuredAgentSessionDraftScopeKey(HOME_CHAT)}
        targetPtyId={null}
        agent="claude"
        structuredTransport={{
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
          sessionId: HOME_CHAT,
          runtimeEnvironmentId: null
        }}
      />
    </div>
  )
}

/** Home's tab: not open yet, kept in the background behind the bot's page, or showing. */
function HomeTab(): React.JSX.Element | null {
  const view = useSyncExternalStore(subscribeHomeView, () => homeView)
  return view === 'not-open' ? null : <HomeChatPane isVisible={view === 'showing'} />
}

function renderBotPage(initialHome: HomeView): void {
  setHomeView(initialHome)
  render(
    <TooltipProvider>
      <BotUpNextSection bot={bot} upNext={upNext} />
      <HomeTab />
    </TooltipProvider>
  )
}

function composerText(): string {
  return promptValue(screen.getByRole('textbox'))
}

function occurrences(text: string, of: string): number {
  return text.split(of).length - 1
}

/** Clicks Start and waits for Home to show and its composer's focus claim to run. */
async function startSuggestion(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Start' }))
  await waitFor(() => expect(screen.getByRole('textbox')).toBe(document.activeElement))
  // The pane's reveal claim runs over a few frames; let it finish before reading the box.
  for (let frame = 0; frame < 8; frame += 1) {
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
  }
}

beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'bots.suggestions.start') {
      return { ask: ASK }
    }
    if (method === 'bots.chat.open') {
      return { sessionId: HOME_CHAT }
    }
    if (method === 'bots.list') {
      return { bots: [bot] }
    }
    return {}
  })
  // Switching to Home's tab shows it, opening it first when it was not open yet.
  mocks.activateHomeTabHere.mockImplementation(() => {
    setHomeView('showing')
    return true
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      git: { discoverCommitMessageModels: vi.fn().mockResolvedValue({ success: false }) },
      pty: { getMainBufferSnapshot: vi.fn().mockResolvedValue(null) }
    }
  })
})

afterEach(() => {
  cleanup()
  setNativeChatComposerDraftStorageForTests(null)
})

describe('a Suggestion’s Start, into Home’s composer', () => {
  it.each<[string, HomeView]>([
    ['kept in the background behind the bot’s page', 'background'],
    ['not open yet', 'not-open'],
    ['already showing', 'showing']
  ])('puts the request in Home’s composer exactly once when Home is %s', async (_label, home) => {
    renderBotPage(home)

    await startSuggestion()

    expect(composerText()).toBe(ASK)
    expect(occurrences(composerText(), ASK)).toBe(1)
  })

  // Suggestions sit beside Home's chat, so a second Start finds Home already showing its request.
  it('keeps the request there once when Start is clicked again: the same request is not added twice', async () => {
    renderBotPage('showing')
    await startSuggestion()
    expect(composerText()).toBe(ASK)

    await startSuggestion()

    // The draft already ends with this request, so a second Start only shows it again.
    expect(composerText()).toBe(ASK)
    expect(occurrences(composerText(), ASK)).toBe(1)
  })
})
