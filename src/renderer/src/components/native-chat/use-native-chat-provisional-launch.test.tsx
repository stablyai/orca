// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type * as ReactModule from 'react'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture
} from '@/lib/structured-agent-session-launch-create-message.test-fixture'
import {
  AWAITING,
  OPERATION_ID,
  SESSION_ID,
  host,
  hostAnswers,
  seedCatalog,
  startReleaseLaunch
} from '@/lib/agent-session/launch/structured-agent-session-host-launch.test-fixture'
import { startStructuredAgentLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchStateChanged
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import { structuredAgentSessionSendBody } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'

// Each store subscription a mounted chat holds, and each callback it receives.
const subscriptions = vi.hoisted(() => ({ live: 0 }))
vi.mock('react', async (original) => {
  const react = await original<typeof ReactModule>()
  return {
    ...react,
    useSyncExternalStore: <T,>(
      subscribe: (notify: () => void) => () => void,
      read: () => T,
      server?: () => T
    ): T => {
      const counted = react.useMemo(
        () => (notify: () => void) => {
          subscriptions.live++
          const stop = subscribe(notify)
          return () => {
            subscriptions.live--
            stop()
          }
        },
        [subscribe]
      )
      return react.useSyncExternalStore(counted, read, server)
    }
  }
})

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
  hostAnswers()
  mocks.exactSupport.mockResolvedValue(true)
  forgetStructuredSessionSelection(SESSION_ID)
  seedCatalog()
})
afterEach(() => cleanupCreateMessageFixture(restore))

/** Another host's held launch, its accept never answered. */
function otherHostLaunch(index: number): string {
  const sessionId = `codex_other_${index}`
  startStructuredAgentLaunch(`workspace-${index + 1}`, 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'runtime:env-2',
    hostLaunch: {
      operationId: `${OPERATION_ID}-${index}`,
      sessionId,
      opening: {
        clientMessageId: `message-${index}`,
        body: structuredAgentSessionSendBody('other', [])
      },
      accept: {
        presentation: 'background',
        setupReceipt: { required: true, runId: `setup-${index}` }
      }
    }
  })
  return sessionId
}

it.each([3, 30])(
  'renders only the chat whose launch changed, beside %i mounted chats',
  async (count) => {
    host.accept.mockReturnValue(new Promise(() => undefined))
    host.prepare.mockResolvedValue({ operationId: OPERATION_ID, state: 'running' })
    const setup = Promise.withResolvers<typeof AWAITING>()
    host.status.mockReturnValueOnce(setup.promise).mockReturnValue(new Promise(() => undefined))
    host.release.mockReturnValue(new Promise(() => undefined))
    startReleaseLaunch()
    const chats = [
      { worktreeId: 'workspace-1', sessionId: SESSION_ID },
      ...Array.from({ length: count - 1 }, (_, index) => ({
        worktreeId: `workspace-${index + 2}`,
        sessionId: otherHostLaunch(index + 1)
      }))
    ]
    const renders = chats.map(() => 0)
    const views = chats.map(({ worktreeId, sessionId }, index) =>
      renderHook(() => {
        renders[index]!++
        return useNativeChatProvisionalLaunch(worktreeId, sessionId)
      })
    )
    try {
      await act(async () => {})
      expect(subscriptions.live).toBe(4 * count)
      const other = getStructuredLaunchStateBySessionId(chats[1]!.sessionId)!

      // Another host's launch saved again without changing: nobody renders.
      renders.fill(0)
      await act(async () => notifyStructuredLaunchStateChanged(other))
      expect(renders).toEqual(chats.map(() => 0))

      // That launch fails: only its own chat renders.
      await act(async () => {
        other.callers.outcome = 'failed'
        notifyStructuredLaunchStateChanged(other)
      })
      expect(renders[1]).toBeGreaterThan(0)
      expect(renders.filter((_, index) => index !== 1)).toEqual(chats.slice(1).map(() => 0))

      // Ours hands its first turn over: only ours renders.
      renders.fill(0)
      await act(async () => {
        setup.resolve(AWAITING)
        await vi.waitFor(() => expect(host.release).toHaveBeenCalledOnce())
      })
      expect(views[0]!.result.current.firstTurnSubmitted).toBe(true)
      expect(renders[0]).toBeGreaterThan(0)
      expect(renders.slice(1)).toEqual(chats.slice(1).map(() => 0))
    } finally {
      views.forEach((view) => view.unmount())
    }
    expect(subscriptions.live).toBe(0)
  }
)
