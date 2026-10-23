// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionCapabilities } from '../../../../shared/agent-session-capabilities'

const CAPABILITIES: AgentSessionCapabilities = {
  rewind: false,
  compact: false,
  threadGoal: false,
  contextUsage: false,
  imagePrompts: true,
  steering: 'queue',
  approvalEnforcement: 'orca'
}

// A local chat names no paired runtime.
vi.mock('@/store', () => ({ useAppStore: () => null }))
// The host's agent list says Grok takes images; one list, as the store keeps it.
const LISTED = [{ agent: 'grok', capabilities: CAPABILITIES }]
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgentsForRuntime: () => LISTED,
  subscribeHostStructuredAgents: () => () => {}
}))

import { useNativeChatStructuredComposerTransport } from './use-native-chat-structured-composer-transport'
import type { useStructuredAgentSession } from './use-structured-agent-session'

function composerAcceptsImages(reported: boolean | undefined): boolean | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building the transport reads only these members; nothing is sent.
  const controller = { acceptsImages: reported } as unknown as ReturnType<
    typeof useStructuredAgentSession
  >
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerTransport({
      props: { agent: 'grok', sessionId: 'session-1', target: { kind: 'local' } },
      controller,
      sendThroughLaunch: () => false,
      starting: false,
      transportEnabled: true,
      worktreeId: undefined,
      optionPickerRequest: null,
      setOptionPickerRequest: () => {},
      onError: () => {},
      onSubmitted: () => {}
    })
  )
  return result.current.acceptsImages
}

describe('the structured composer image gate', () => {
  it("follows the session's options answer over the host's agent list", () => {
    expect(composerAcceptsImages(false)).toBe(false)
    expect(composerAcceptsImages(true)).toBe(true)
    // No answer yet, or an older host: the agent list decides.
    expect(composerAcceptsImages(undefined)).toBe(true)
  })
})
