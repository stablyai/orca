// @vitest-environment happy-dom
// CHAT-CANCEL-ERROR / CHAT-RESTORE-RECONFIRM: a structured chat held on its Orca Cloud strip has
// created nothing, so it never shows "Chat could not be started" or "Chat connection could not be
// confirmed" (nor a session error card). Once the hold is gone, a real start's failure still says so.
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLaunchLifecycle } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'

const cloud = vi.hoisted(() => ({ held: false }))
vi.mock('@/lib/orca-cloud/cloud-structured-launch-hold', () => ({
  useIsCloudHeldChat: () => cloud.held,
  useCloudHeldChatUnavailable: (_sessionId: string, unavailable: unknown) => unavailable ?? null
}))
vi.mock('../../host-access/native-chat-host-setup', () => ({
  useNativeChatHostSetup: () => null,
  nativeChatSetupAction: () => null
}))
vi.mock('./use-native-chat-availability-notice', () => ({
  useNativeChatAvailabilityNotice: () => null
}))

const { useNativeChatStructuredPaneNotices } =
  await import('./use-native-chat-structured-pane-notices')

function notices(
  lifecycle: StructuredAgentSessionLaunchLifecycle | null,
  sessionError: string | null = null
): string[] {
  const args = {
    props: { sessionId: 'session-1', agent: 'claude' },
    ownerWorktreeId: 'wt-1',
    provisionalLaunch: { lifecycle, failure: null },
    submits: { retryLaunch: () => undefined },
    startFailures: [],
    controller: {
      optionSurface: {},
      unavailable: null,
      error: sessionError,
      journalItems: [],
      submissions: []
    },
    continuation: { view: {}, continueError: null },
    deliveryNotices: [],
    agentLabel: 'Claude',
    viewState: { kind: 'ready' },
    readFailure: null,
    composerError: null,
    install: { slot: { kind: 'none' } },
    hostSendGate: { notice: null },
    hostNotice: null
  }
  const { result } = renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the fields above.
    useNativeChatStructuredPaneNotices(args as never)
  )
  return result.current.notices.map((notice) => notice.text)
}

beforeEach(() => {
  cloud.held = false
})

describe('launch notices on a structured chat held on Orca Cloud', () => {
  it('after a restart, a held chat past its confirm window shows no reconfirm error', () => {
    cloud.held = true
    expect(notices('visibility-unknown')).toEqual([])
  })

  it('a held chat whose launch reads failed shows no "could not be started"', () => {
    cloud.held = true
    expect(notices('failed')).toEqual([])
  })

  it('a held chat shows no session error card either', () => {
    cloud.held = true
    expect(notices(null, 'Chat history is unavailable.')).toEqual([])
  })

  it('once the hold is gone, a real start that fails still says so', () => {
    expect(notices('failed')).toEqual(['Chat could not be started.'])
  })

  it('a chat that is not held keeps its reconfirm notice', () => {
    expect(notices('visibility-unknown')).toEqual(['Chat connection could not be confirmed.'])
  })
})
