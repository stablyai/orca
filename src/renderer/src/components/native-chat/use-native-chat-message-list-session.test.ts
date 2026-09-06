// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import {
  useNativeChatMessageListSession,
  type UseNativeChatMessageListSessionArgs
} from './use-native-chat-message-list-session'
import { OMP_RPC_OVERLAY_ASSISTANT_ID } from './omp-rpc-turn-overlay'

function baseSession(messages: NativeChatMessage[] = []): NativeChatLiveSession {
  return {
    messages,
    status: 'working',
    sessionId: 'session-1',
    agent: 'omp',
    hasMore: false,
    omitsOlderRecords: false,
    loadingEarlier: false,
    loadEarlier: () => {},
    readPhase: 'ready'
  }
}

function args(
  overrides: Partial<UseNativeChatMessageListSessionArgs> = {}
): UseNativeChatMessageListSessionArgs {
  return {
    session: baseSession(),
    paneLaunchPrompt: null,
    commandMarkers: [],
    pending: [],
    liveWorking: true,
    hookPreview: undefined,
    hookPreviewIsToolOutput: false,
    overlayMessages: [],
    ...overrides
  }
}

const overlayMessage: NativeChatMessage = {
  id: OMP_RPC_OVERLAY_ASSISTANT_ID,
  role: 'assistant',
  blocks: [{ type: 'text', text: 'streaming reply' }],
  timestamp: null,
  source: 'rpc'
}

describe('useNativeChatMessageListSession', () => {
  it('returns the boundary-applied session unchanged when there is nothing to splice', () => {
    const { result } = renderHook(() => useNativeChatMessageListSession(args()))
    expect(result.current.sessionWithPending).toBe(result.current.sessionAfterCommandBoundaries)
  })

  it('splices the RPC overlay in after the transcript and before pending sends', () => {
    const pendingSend = {
      id: 'pending:1',
      text: 'queued',
      sentAt: 1,
      afterMessageId: null,
      afterMessageTimestamp: null
    }
    const { result } = renderHook(() =>
      useNativeChatMessageListSession(
        args({
          session: baseSession([
            {
              id: 't-1',
              role: 'user',
              blocks: [{ type: 'text', text: 'hi' }],
              timestamp: 1,
              source: 'transcript'
            }
          ]),
          overlayMessages: [overlayMessage],
          pending: [pendingSend]
        })
      )
    )

    const ids = result.current.sessionWithPending.messages.map((message) => message.id)
    expect(ids).toEqual(['t-1', OMP_RPC_OVERLAY_ASSISTANT_ID, 'pending:pending:1'])
  })

  it('never both: a hook-preview streaming bubble and the RPC overlay do not double up', () => {
    const { result } = renderHook(() =>
      useNativeChatMessageListSession(
        args({ hookPreview: 'from the PTY hook', overlayMessages: [overlayMessage] })
      )
    )

    // The caller (use-native-chat-omp-rpc-integration.ts) is responsible for
    // ensuring these two never carry real content at the same time; this
    // hook just proves both are individually spliceable without collision.
    const ids = result.current.sessionWithPending.messages.map((message) => message.id)
    expect(ids.filter((id) => id === 'streaming' || id === OMP_RPC_OVERLAY_ASSISTANT_ID)).toEqual([
      'streaming',
      OMP_RPC_OVERLAY_ASSISTANT_ID
    ])
  })
})
