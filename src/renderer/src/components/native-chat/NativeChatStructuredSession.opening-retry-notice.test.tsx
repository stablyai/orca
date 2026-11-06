// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { i18n } from '@/i18n/i18n'
import fr from '@/i18n/locales/fr.json'
import type * as Launch from '@/lib/agent-session/launch/structured-agent-session-launch'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof Launch>()),
  retryStructuredAgentSessionLaunch: mocks.retryLaunch
}))
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

afterEach(async () => {
  cleanup()
  resetStructuredSessionMocks()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionSendsForTests()
  localStorage.clear()
  await i18n.changeLanguage('en')
})

function restoreOpening() {
  writeStructuredAgentLaunchRecord({
    sessionId: 'opening-notice-session',
    executionHostId: 'local',
    agent: 'codex',
    lifecycle: 'visibility-unknown',
    clientOperationId: 'original-create',
    payloadFingerprint: 'original-payload',
    expectedRuntimeFence: null,
    createMessageSupport: true,
    firstMessage: {
      clientMessageId: 'original-opening',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Keep this opening' }] }
    }
  })
  mocks.messages = [
    {
      id: 'orca:original-opening',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Keep this opening' }]
    }
  ]
}

function renderPane() {
  return render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="opening-notice-tab"
      sessionId="opening-notice-session"
      target={{ kind: 'local' }}
      agent="codex"
    />
  )
}

it.each(['en', 'fr'])(
  'keeps restored opening recovery with its launch notice in %s',
  async (language) => {
    i18n.addResourceBundle('fr', 'translation', fr)
    await i18n.changeLanguage(language)
    restoreOpening()
    mocks.status = 'error'
    mocks.readRefusal = {
      code: 'agent_session_identity_required',
      details: { reason: 'recordMissing' }
    }
    renderPane()
    expect(mocks.controllerProps?.transportEnabled).toBe(true)
    expect(mocks.composerProps?.notices?.map(({ key }) => key)).toEqual(['launch'])
    fireEvent.click(screen.getByRole('button'))
    expect(mocks.retryLaunch).toHaveBeenCalledExactlyOnceWith('wt-1', 'opening-notice-session')
  }
)

it('keeps an unrelated read refusal with its history owner despite unresolved creation', () => {
  restoreOpening()
  mocks.status = 'error'
  mocks.readRefusal = {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalUnavailable' }
  }
  renderPane()
  expect(mocks.composerProps?.notices?.map(({ key }) => key)).toEqual(['session'])
})

it('preserves the launch cause and its action instead of borrowing it for missing-history advice', () => {
  const retry = vi.fn()
  const notices = structuredSessionNotices({
    launch: {
      lifecycle: 'visibility-unknown',
      failure: {
        kind: 'refused',
        code: 'agent_session_operation_invalid',
        details: { reason: 'cliMissing' },
        causeText: 'Codex needs its command installed.'
      },
      retry
    },
    agentLabel: 'Codex',
    sessionError: 'Missing history advice',
    readRefusal: {
      code: 'agent_session_identity_required',
      details: { reason: 'recordMissing' }
    },
    composerError: null
  })
  expect(notices.map(({ key }) => key)).toEqual(['launch'])
  render(<NativeChatComposerNotices notices={notices} />)
  expect(screen.getByText(/Codex needs its command installed/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button'))
  expect(retry).toHaveBeenCalledOnce()
})
