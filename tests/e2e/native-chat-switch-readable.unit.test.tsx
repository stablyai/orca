import { prepareReadableSwitchSource } from './helpers/native-chat-switch-readable-source'
import { createRestTestRig } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { HOST_TEST_SESSION } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { parseAgentJournalItemKey } from '../../src/shared/agent-session-journal-item-key'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A
} from '../../src/main/runtime/main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from '../../src/main/runtime/rpc/methods/structured-agent-session-switch-execution'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatStructuredSession } from '../../src/renderer/src/components/native-chat/NativeChatStructuredSession'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  stubLayout,
  stubResizeObserver,
  deliverResizes
} from '../../src/renderer/src/components/native-chat/native-chat-windowing-test-harness'
import { resetStructuredAgentSessionReadOwnersForTests } from '../../src/renderer/src/components/native-chat/structured-agent-session-read-owner'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../src/shared/agent-session-wire'
import type * as StructuredAgentSessionClientModule from '@/runtime/structured-agent-session-client'

// @vitest-environment happy-dom

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (
    await import('../../src/renderer/src/components/native-chat/NativeChatStructuredSession.test-harness')
  ).createStructuredSessionMocks()
)
const feed = vi.hoisted(() => ({ cursor: { epoch: 'epoch', sequence: 1 } }))
vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', async (actual) => ({
  ...(await actual<typeof StructuredAgentSessionClientModule>()),
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: async (
    _target: unknown,
    params: { sessionId: string },
    onEvent: (event: AgentSessionSubscribeEvent) => void
  ) => {
    onEvent({
      type: 'batch',
      sessionId: params.sessionId,
      batch: {
        cursor: feed.cursor,
        items: [],
        removedItemIds: [],
        submissions: []
      }
    })
    return { unsubscribe: () => {} }
  },
  subscribeStructuredAgentSessionStatus: async () => ({ unsubscribe: () => {} }),
  supportsStructuredAgentSessionQuietRepeatedStop: async () => false
}))
vi.mock('../../src/renderer/src/components/native-chat/use-native-chat-font-size', () =>
  moduleFactories.useNativeChatFontSize()
)
vi.mock('../../src/renderer/src/components/native-chat/use-native-chat-file-link-context', () =>
  moduleFactories.useNativeChatFileLinkContext()
)
vi.mock('../../src/renderer/src/components/native-chat/use-native-chat-file-link-click', () =>
  moduleFactories.useNativeChatFileLinkClick()
)
vi.mock('../../src/renderer/src/components/native-chat/NativeChatComposer', () =>
  moduleFactories.nativeChatComposer()
)
vi.mock('../../src/renderer/src/components/native-chat/NativeChatApprovalCard', () =>
  moduleFactories.nativeChatApprovalCard()
)
vi.mock('../../src/renderer/src/components/native-chat/NativeChatQuestionCard', () =>
  moduleFactories.nativeChatQuestionCard()
)
const restores: (() => void)[] = []
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) {
    await dispose()
  }
  setStructuredAgentSessionHost(null)
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredSessionMocks()
  for (const restore of restores.splice(0).toReversed()) {
    restore()
  }
  vi.restoreAllMocks()
})
it.each(['readable'] as const)(
  'completes one physical switch independently of slow provider readiness and renderer history: %s',
  async () => {
    const restoreLayout = stubLayout()
    const restoreResize = stubResizeObserver()
    restores.push(restoreLayout, restoreResize)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({})
    }))
    const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    disposals.push(rig.dispose)
    setStructuredAgentSessionHost(rig.host)
    await prepareReadableSwitchSource(rig, WORKTREE_ID)
    const { runtime, session } = setupMainOwnedWorkspace()
    const incarnationId = '11111111-1111-4111-8111-111111111111'
    runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
    const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
    if (!source.presentation) {
      throw new Error('missing captured source')
    }
    const exit = Promise.withResolvers<void>()
    const stopping = Promise.withResolvers<void>()
    disposals.unshift(async () => exit.resolve())
    const stopped = vi.fn(async (ptyId: string) => {
      expect(ptyId).toBe(PTY_A)
      stopping.resolve()
      await exit.promise
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: stopped,
      getForegroundProcess: async () => 'codex'
    })
    const acquire = rig.adapter.acquire.getMockImplementation()
    if (!acquire) {
      throw new Error('missing provider acquisition')
    }
    const provider = Promise.withResolvers<void>()
    disposals.unshift(async () => provider.resolve())
    const providerReady = vi.fn()
    rig.adapter.acquire.mockImplementation(async (...args) => {
      await provider.promise
      const acquired = await acquire(...args)
      providerReady()
      return acquired
    })
    const publish = vi.spyOn(runtime, 'publishStructuredAgentSessionTab')
    const invocation = {
      sessionId: HOST_TEST_SESSION,
      execution: {
        invocationId: 'root-readable',
        source: {
          terminal: source.handle,
          expectedIncarnationId: incarnationId,
          originalPresentation: source.presentation
        }
      }
    }
    const operation = executeStructuredSessionSwitch(invocation, { runtime }, 'chat')
    await Promise.race([
      stopping.promise,
      operation.then((result) => {
        throw new Error(`switch finished before physical Stop: ${JSON.stringify(result)}`)
      })
    ])
    expect(publish).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    exit.resolve()
    const completed = await operation
    expect(completed).toEqual({ status: 'completed', sessionId: HOST_TEST_SESSION })
    expect(stopped).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledOnce()
    expect(session().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(session().unifiedTabs?.[WORKTREE_ID]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: HOST_TEST_SESSION, contentType: 'agent-session' })
      ])
    )
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
    expect(providerReady).not.toHaveBeenCalled()
    const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    if (!page.ok || !page.page.liveCursor) {
      throw new Error('missing imported history')
    }
    expect(
      page.page.items
        .filter(({ body }) => body.kind === 'message')
        .map(({ itemId }) => parseAgentJournalItemKey(itemId))
    ).toEqual([expect.objectContaining({ provider: 'legacy', agent: 'codex', recordId: '#2' })])
    feed.cursor = page.page.liveCursor
    const read = Promise.withResolvers<AgentSessionHistoryResult>()
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'agentSession.history') {
        return read.promise
      }
      return { ok: true, models: [], current: { model: '' } }
    })
    render(
      <ConfirmationDialogProvider>
        <TooltipProvider>
          <NativeChatStructuredSession
            isVisible
            isFocusedGroup
            tabId="cold-tab"
            sessionId={HOST_TEST_SESSION}
            target={{ kind: 'local' }}
            agent="codex"
          />
        </TooltipProvider>
      </ConfirmationDialogProvider>
    )
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        expect.anything(),
        'agentSession.history',
        expect.anything()
      )
    )
    expect(screen.getByRole('status', { name: 'Loading chat' })).toBeTruthy()
    await act(async () => {
      read.resolve(page)
    })
    await waitFor(() => {
      act(() => deliverResizes())
      expect(screen.getByText('Readable before Codex is ready')).toBeTruthy()
    })
    expect(providerReady).not.toHaveBeenCalled()
    expect(stopped).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledOnce()
    expect(
      await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    ).toMatchObject({
      ok: true
    })
    provider.resolve()
    await vi.waitFor(() => expect(providerReady).toHaveBeenCalledOnce())
  }
)
