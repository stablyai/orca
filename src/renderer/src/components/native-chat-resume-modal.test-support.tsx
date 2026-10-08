import { act } from 'react'
import { toast } from 'sonner'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { TooltipProvider } from './ui/tooltip'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import { consumeNativeChatResumeOnRestartDialogRequest } from './native-chat-resume-on-restart-dialog'
import {
  _resetNativeChatRestartOffer,
  getNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

export const offered: ResumeCandidate[] = ['a', 'b'].map((sessionId) => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1_800_000_000_000,
  executionHostId: 'local',
  workspaceKind: 'git-worktree'
}))

/** A chat the host acted on and could not carry on, as it reports it. */
export function failure(
  sessionId: string,
  reason = 'agent_session_restart_work_superseded'
): ResumeFailure {
  const candidate = offered.find((entry) => entry.sessionId === sessionId)!
  return {
    ...candidate,
    failedAt: candidate.recordedAt + 60_000,
    outcome: 'refused',
    reason
  }
}

export type RestartRpc = (
  target: unknown,
  method: string,
  params?: { sessionIds?: string[] }
) => Promise<unknown>
export type ResumeStatusStream = {
  emit: (event: AgentSessionStatusEvent) => void
  snapshot: Map<string, AgentSessionStatusSummary>
}

export function createResumeModalFixture(rpc: Mock<RestartRpc>, statusStream: ResumeStatusStream) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let root: Root
  let container: HTMLDivElement
  /** Outcome rows carry tooltips, so every mount needs the provider the app shell supplies. */
  async function mount(node: React.ReactNode): Promise<void> {
    await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  }

  function button(text: string): HTMLButtonElement {
    const found = [...document.querySelectorAll('button')].find(
      (entry) => entry.textContent?.trim() === text || entry.getAttribute('aria-label') === text
    )
    if (!found) {
      throw new Error(`Missing button: ${text}`)
    }
    return found
  }

  function checkbox(index: number): HTMLElement {
    const found = document.querySelectorAll<HTMLElement>('[role="checkbox"]')[index]
    if (!found) {
      throw new Error(`Missing checkbox: ${index}`)
    }
    return found
  }

  function offerIds(): string[] {
    return getNativeChatRestartOffer().candidates.map((candidate) => candidate.sessionId)
  }

  /** What each toast said: its title, and its description when it has one. */
  function toasts(): unknown[][] {
    return vi
      .mocked(toast)
      .mock.calls.map(([title, options]) =>
        options?.description === undefined ? [title] : [title, options.description]
      )
  }

  type Verdict = 'continued' | 'refused' | 'unknown' | 'skipped'

  /** A bulk host action publishes each verdict before returning its authoritative list. */
  function fakeHost(
    init: { sessions?: ResumeCandidate[]; failed?: ResumeFailure[] } = {},
    verdictFor: (sessionId: string) => Verdict = () => 'continued',
    reason = 'agent_session_restart_work_superseded'
  ) {
    const state = { sessions: [...(init.sessions ?? offered)], failed: [...(init.failed ?? [])] }
    const held = new Map<string, PromiseWithResolvers<void>>()
    rpc.mockImplementation(
      async (_target, method, params: { sessionIds?: string[] } | undefined) => {
        if (method === 'agentSession.restartResumable') {
          return { sessions: state.sessions, failed: state.failed }
        }
        if (method === 'agentSession.restartResumableDismiss') {
          state.failed = state.failed.filter(
            (entry) => !params?.sessionIds?.includes(entry.sessionId)
          )
          state.sessions = state.sessions.filter(
            (entry) => !params?.sessionIds?.includes(entry.sessionId)
          )
          return { sessions: state.sessions, failed: state.failed }
        }
        const continued = await Promise.all(
          (params?.sessionIds ?? []).map(async (sessionId) => {
            await held.get(sessionId)?.promise
            const verdict = verdictFor(sessionId)
            if (verdict === 'skipped') {
              const summary: AgentSessionStatusSummary = {
                sessionId,
                workspaceId: 'workspace',
                agent: 'codex',
                status: 'idle',
                latestPrompt: '',
                updatedAt: 1,
                restartResume: { phase: 'skipped' }
              }
              statusStream.snapshot.set(sessionId, summary)
              statusStream.emit({ type: 'status', session: summary })
              return []
            }
            state.sessions = state.sessions.filter((entry) => entry.sessionId !== sessionId)
            state.failed = state.failed.filter((entry) => entry.sessionId !== sessionId)
            const phase = verdict === 'unknown' ? 'unconfirmed' : verdict
            if (verdict !== 'continued') {
              state.failed.push({
                ...failure(sessionId, reason),
                outcome: phase === 'refused' ? 'refused' : 'unconfirmed'
              })
            }
            const summary: AgentSessionStatusSummary = {
              sessionId,
              workspaceId: 'workspace',
              agent: 'codex',
              status: 'idle',
              latestPrompt: '',
              updatedAt: 1,
              restartResume: { phase }
            }
            statusStream.snapshot.set(sessionId, summary)
            statusStream.emit({ type: 'status', session: summary })
            return [{ sessionId, outcome: verdict }]
          })
        )
        const skipped: string[] = []
        for (const sessionId of params?.sessionIds ?? []) {
          const previous = statusStream.snapshot.get(sessionId)
          if (!previous) {
            continue
          }
          if (previous.restartResume?.phase === 'skipped') {
            skipped.push(sessionId)
          }
          const { restartResume: _restartResume, ...summary } = previous
          statusStream.snapshot.set(sessionId, summary)
          statusStream.emit({ type: 'status', session: summary })
        }
        return {
          resumed: [],
          continued: continued.flat(),
          skipped,
          sessions: state.sessions,
          failed: state.failed
        }
      }
    )
    return {
      state,
      hold: (...sessionIds: string[]) =>
        sessionIds.forEach((sessionId) => held.set(sessionId, Promise.withResolvers<void>())),
      release: async (...sessionIds: string[]) =>
        act(async () => sessionIds.forEach((sessionId) => held.get(sessionId)?.resolve()))
    }
  }

  /** The status icon a run shows in a chat's checkbox slot, found by its chat and what it says. */
  function runStatus(prompt: string): string | null {
    return (
      document
        .querySelector(`[role="img"][aria-label^="${prompt}: "]`)
        ?.getAttribute('aria-label') ?? null
    )
  }

  function calls(): unknown[][] {
    return rpc.mock.calls.map((call) => [call[1], call[2]])
  }

  beforeEach(() => {
    rpc.mockReset()
    resetStructuredAgentSessionStatusFeedsForTests()
    statusStream.snapshot.clear()
    statusStream.emit = () => {}
    _resetNativeChatRestartOffer()
    consumeNativeChatResumeOnRestartDialogRequest()
    vi.mocked(toast).mockClear()
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), experimentalNativeChat: true },
      updateSettings: async (changes) => {
        useAppStore.setState((state) => ({
          settings: { ...getDefaultSettings(''), ...state.settings, ...changes }
        }))
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useAppStore.setState(useAppStore.getInitialState(), true)
    _resetNativeChatRestartOffer()
    consumeNativeChatResumeOnRestartDialogRequest()
  })
  return { mount, button, checkbox, offerIds, toasts, fakeHost, runStatus, calls }
}
