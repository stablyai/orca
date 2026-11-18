// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, type KeyboardEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { z } from 'zod'
import type { StructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import type { AgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultSessionListKeyboard } from './use-ai-vault-session-keyboard-navigation'
import type { AiVaultResumeHere } from '../session-actions/ai-vault-session-resume-here'
import * as resumeHere from '../session-actions/ai-vault-session-resume-here'

const VIEWPORT_PX = 600
const ROW_PX = 98

vi.mock('./AiVaultSessionRow', () => ({
  VaultSessionRow: (props: { session: AiVaultSession; onPick?: () => void }) => (
    <div onClick={props.onPick}>{props.session.title}</div>
  )
}))
// The host's side of a resumed chat: it admits the chat, then the launch settles as the test says.
const launch = vi.hoisted(
  (): {
    sessionId: string
    settlement: StructuredAgentLaunchSettlement
    /** The host's admission refused before any tab opened. */
    refusedBeforeSurface?: Error
  } => ({
    sessionId: 'new',
    settlement: { kind: 'structured', sessionId: 'new' }
  })
)
vi.mock('@/lib/agent-session/resume/history/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: async (session: AiVaultSession) => session
}))
vi.mock('@/lib/agent-session/launch/routing/agent-session-launch-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adoptAgentSessionLaunchVerdict: (verdict: AgentSessionLaunchVerdict) => ({
    ...verdict,
    begin: () => ({
      sessionId: launch.sessionId,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      settlement: Promise.resolve(launch.settlement),
      cancel: vi.fn()
    })
  })
}))
vi.mock(
  '@/lib/agent-session/launch/structured-agent-session-launch-admission',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    beginHostAdmittedStructuredLaunch: (args: {
      openAdmitted: () => { settlement: Promise<StructuredAgentLaunchSettlement> } | null
    }) => ({
      sessionId: null,
      tab: null,
      settlement: launch.refusedBeforeSurface
        ? Promise.resolve({ kind: 'failed', error: launch.refusedBeforeSurface })
        : args.openAdmitted()?.settlement,
      cancel: vi.fn()
    })
  })
)
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
const observation = vi.hoisted(() => ({ value: 'live' }))
vi.mock('@/runtime/native-chat/status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    getSessionObservation: () => observation.value,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/runtime/native-chat/tab-retirement/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: vi.fn()
}))
const opening = vi.hoisted(() => ({ successor: false, refused: false }))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => undefined
}))

async function publishOpenedChat(workspace: string, sessionId: string) {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await layoutApplyTestTransport.call({
      command: {
        type: 'openAgentSessionTab',
        workspace,
        tabId: sessionId,
        sessionId,
        agent: 'claude'
      }
    })
    await layoutApplyTestTransport.settle()
  } else {
    useAppStore.getState().createUnifiedTab(workspace, 'agent-session', {
      id: sessionId,
      entityId: sessionId,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      agentSessionAgent: 'claude'
    })
  }
}

// Switch-on, main opens and closes the chat tabs and its frames draw them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => {
  const rpc = (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...rpc,
    callRuntimeRpc: async (...args: Parameters<typeof rpc.callRuntimeRpc>) => {
      const workspace = useAppStore.getState().activeWorktreeId!
      if (args[1] === 'orchestration.partyLocation') {
        if (opening.refused) {
          throw new Error('unavailable')
        }
        const address = z.object({ address: z.string() }).parse(args[2]).address
        return {
          location: {
            kind: 'chat',
            worktreeId: workspace,
            sessionId: opening.successor ? 'successor' : address.slice('orca_session_id:'.length)
          }
        }
      }
      if (args[1] === 'agentSession.reveal') {
        const sessionId = z.object({ sessionId: z.string() }).parse(args[2]).sessionId
        await publishOpenedChat(workspace, sessionId)
        return { ok: true, sessionId, workspaceId: workspace, agent: 'claude', readable: true }
      }
      if (args[1] === 'session.tabs.activate') {
        return { ok: true }
      }
      return args[1] === 'agentSession.history'
        ? Promise.resolve({
            ok: true,
            page: {
              sessionId: z.object({ sessionId: z.string() }).parse(args[2]).sessionId,
              epoch: 'idle',
              direction: 'tail',
              items: [],
              removedItemIds: [],
              submissions: [],
              window: { oldest: null, newest: null, nextCursor: null },
              hasOlder: false,
              hasNewer: false,
              working: false,
              actionablePromptIds: [],
              latestTurn: null,
              nextQueuedMessageId: null,
              backgroundTasks: null
            }
          })
        : rpc.callRuntimeRpc(...args)
    }
  }
})
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'
import type { TabsDrawnFromMain } from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function session(n: number): AiVaultSession {
  return {
    id: `local:claude:s-${n}`,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: `s-${n}`,
    title: `Session ${n}`,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/s-${n}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-09-17T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: 'Fix it', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `claude --resume s-${n}`,
    subagent: null
  }
}

const sessions = Array.from({ length: 30 }, (_, n) => session(n))

function renderList(
  options: {
    groups?: AiVaultSessionListGroup[]
    collapsedGroups?: ReadonlySet<string>
    openSessionIds?: ReadonlySet<string>
    eligible?: (session: AiVaultSession) => boolean
    resumeHere?: AiVaultResumeHere
  } = {}
) {
  const keyboard = createRef<AiVaultSessionListKeyboard>()
  const calls = {
    onJumpToOriginalPane: vi.fn(),
    onResumeInNewChat: vi.fn(),
    onResume: vi.fn()
  }
  const groups = options.groups ?? [{ key: 'all', label: null, sessions }]
  const list = (query: string) => (
    <AiVaultSessionVirtualList
      query={query}
      groups={groups}
      collapsedGroups={options.collapsedGroups ?? new Set()}
      loading={false}
      sessionsCount={sessions.length}
      filteredSessionsCount={sessions.length}
      noAgentsSelected={false}
      error={null}
      vaultScope="workspace"
      buildResumeStartup={() => ({ command: '' })}
      onRevealArtifacts={vi.fn()}
      getOriginalPaneTarget={() => null}
      isStructuredSessionOpen={(s) => options.openSessionIds?.has(s.id) ?? false}
      getSessionLiveState={() => null}
      getWorktreeInfo={() => null}
      getSessionResumeState={() => ({
        blocked: false,
        worktreeId: 'wt-1',
        usesSessionWorktree: true
      })}
      getSessionResumeActions={() => ({
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: 'wt-1', disabled: false }
      })}
      getSessionResumeInChat={(s) =>
        (options.eligible?.(s) ?? true)
          ? {
              available: true,
              workspaceId: options.resumeHere?.workspaceId ?? `own-${s.sessionId}`
            }
          : { available: false, reason: 'remote' }
      }
      onToggleGroup={vi.fn()}
      onJumpToOriginalPane={calls.onJumpToOriginalPane}
      onJumpToWorktree={vi.fn()}
      onResume={calls.onResume}
      onContinueInNewSession={vi.fn()}
      onResumeInNewChat={calls.onResumeInNewChat}
      onResumeInNewCli={vi.fn()}
      onCopyResume={vi.fn()}
      onCopyId={vi.fn()}
      onCopyPath={vi.fn()}
      onOpenLog={vi.fn()}
      onRevealLog={vi.fn()}
      onOpenCwd={vi.fn()}
      onRequestDelete={vi.fn()}
      keyboardRef={keyboard}
      resumeHere={options.resumeHere}
    />
  )
  const view = render(list(''))
  const press = (key: string, repeat = false) => {
    const event = { key, repeat, preventDefault: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only key, modifiers, repeat and preventDefault.
    act(() => keyboard.current?.handleKeyDown(event as unknown as KeyboardEvent<HTMLElement>))
    return event
  }
  return { calls, press, search: (query: string) => view.rerender(list(query)) }
}

beforeEach(() => {
  toastError.mockClear()
  opening.successor = false
  opening.refused = false
  // Why: happy-dom has no layout; give the virtualizer a bounded viewport and fixed rows.
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('overflow-y-auto') ? VIEWPORT_PX : ROW_PX
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isScroller = this.classList.contains('overflow-y-auto')
    return new DOMRect(0, 0, 400, isScroller ? VIEWPORT_PX : ROW_PX)
  })
})

let main: TabsDrawnFromMain | undefined

afterEach(() => {
  main?.close()
  main = undefined
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("a room's Session History picker", () => {
  const room = { tabId: 'room-tab', workspaceId: 'folder:room-home', alongside: true }

  it('opens a closed conversation in its own tab as its own agent, by Enter or by click', () => {
    const dismiss = vi.fn()
    const replace = vi.spyOn(resumeHere, 'resumeAiVaultSessionHere')
    const { calls, press } = renderList({
      resumeHere: { ...room, dismiss, confirm: vi.fn() }
    })
    press('Enter')
    expect(calls.onResumeInNewChat).toHaveBeenLastCalledWith(sessions[0], 'folder:room-home')
    fireEvent.click(screen.getByText('Session 2'))
    expect(calls.onResumeInNewChat).toHaveBeenLastCalledWith(sessions[2], 'folder:room-home')
    expect(dismiss).toHaveBeenCalledTimes(2)
    expect(replace).not.toHaveBeenCalled()
  })

  it('reopens a closed chat, and switches to one already open, without touching the room', () => {
    const structured = {
      ...sessions[0],
      structuredSession: { sessionId: 'chat-0', workspaceId: 'folder:room-home' }
    }
    const { calls, press } = renderList({
      groups: [{ key: 'all', label: null, sessions: [structured, sessions[1]] }],
      openSessionIds: new Set([sessions[1].id]),
      resumeHere: { ...room, dismiss: vi.fn(), confirm: vi.fn() }
    })
    press('Enter')
    expect(calls.onResume).toHaveBeenCalledWith(structured, 'wt-1')
    press('ArrowDown')
    press('Enter')
    expect(calls.onJumpToOriginalPane).toHaveBeenCalledWith(sessions[1])
    expect(calls.onResumeInNewChat).not.toHaveBeenCalled()
  })
})
