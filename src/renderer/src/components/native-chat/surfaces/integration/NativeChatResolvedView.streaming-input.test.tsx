// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatComposerProps } from '../../composer/native-chat-composer-types'
import type { AgentStatusPayload } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type * as StreamingModule from '../../../../../../shared/native-chat/native-chat-streaming'
import { clearPendingSendCacheForTests } from '../../session/terminal/delivery/native-chat-pending'

const probe = vi.hoisted<{
  session: NativeChatLiveSession | null
  inputs: (readonly NativeChatMessage[])[]
  shown: NativeChatMessage[]
}>(() => ({ session: null, inputs: [], shown: [] }))
vi.mock('../../session/terminal/read/use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => probe.session
}))
vi.mock('../../NativeChatMessageList', () => ({
  NativeChatMessageList: ({ session }: { session: NativeChatLiveSession }) => {
    probe.shown = session.messages
    return null
  }
}))
vi.mock('../../composer/NativeChatComposer', () => ({
  NativeChatComposer: ({ onOptimisticSend }: NativeChatComposerProps) => (
    <button onClick={() => onOptimisticSend?.('Follow up')}>send</button>
  )
}))
vi.mock('../../../../../../shared/native-chat/native-chat-streaming', async (importOriginal) => {
  const original = await importOriginal<typeof StreamingModule>()
  return {
    ...original,
    deriveNativeChatStreamingText: (
      args: Parameters<typeof original.deriveNativeChatStreamingText>[0]
    ) => {
      probe.inputs.push(args.messages)
      return original.deriveNativeChatStreamingText(args)
    }
  }
})

const { NativeChatResolvedView } = await import('../../NativeChatResolvedView')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { useAppStore } = await import('../../../../store/index')
const paneKey = 'preview-perf:leaf'
const message = (id: string, role: 'user' | 'assistant', text: string): NativeChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript'
})

function setPreview(text: string, extra: Partial<AgentStatusPayload> = {}): void {
  useAppStore.getState().setAgentStatus(paneKey, {
    prompt: 'Prompt',
    agentType: 'claude',
    state: 'working',
    lastAssistantMessage: text,
    ...extra
  })
}

function previewTicks(expected: readonly NativeChatMessage[], extra = {}): void {
  probe.inputs = []
  for (let tick = 0; tick < 20; tick += 1) {
    act(() => setPreview(`Current reply ${tick}`, extra))
  }
  expect(probe.inputs.length).toBeGreaterThanOrEqual(20)
  expect(new Set(probe.inputs).size).toBe(1)
  expect(probe.inputs[0]).toBe(expected)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
  clearPendingSendCacheForTests()
  probe.inputs = []
  probe.shown = []
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  clearPendingSendCacheForTests()
  useAppStore.setState({ agentStatusByPaneKey: {}, nativeChatLaunchPromptByTabId: {} })
})

describe('preview input allocation at realistic history sizes', () => {
  it.each([1_000, 10_000])('reuses input across ticks with %i loaded messages', (size) => {
    const transcript = Array.from({ length: size }, (_, index) =>
      message(`history-${index}`, index % 2 ? 'assistant' : 'user', `History ${index}`)
    )
    probe.session = {
      messages: transcript,
      status: 'working',
      sessionId: 'preview-perf',
      agent: 'claude',
      hasMore: false,
      loadingEarlier: false,
      olderHistoryGeneration: 0,
      loadEarlier: vi.fn(),
      readPhase: 'ready'
    }
    setPreview('Current reply')
    render(
      <TooltipProvider>
        <NativeChatResolvedView
          paneKey={paneKey}
          agent="claude"
          sessionId="preview-perf"
          transcriptPath={null}
          isVisible
          isFocusedGroup
          targetPtyId="preview-perf-pty"
          terminalTabId="preview-perf"
          ownsTabWideLaunchDraft={false}
        />
      </TooltipProvider>
    )
    previewTicks(transcript)
    act(() => fireEvent.click(screen.getByRole('button', { name: 'send' })))
    const queued = probe.inputs.at(-1)!
    expect(queued).toHaveLength(size + 1)
    expect(queued.at(-1)?.pendingSend).toBe('queued')
    previewTicks(queued)
    expect(probe.shown.at(-2)?.id).toBe('streaming')
    expect(probe.shown.at(-1)?.pendingSend).toBe('queued')
    previewTicks(queued, { lastAssistantMessageIsToolOutput: true })

    const caughtUp = [...transcript, message('reply', 'assistant', 'Current reply 19')]
    act(() => {
      probe.session = { ...probe.session!, messages: caughtUp }
      setPreview('Current reply 19')
    })
    const updated = probe.inputs.at(-1)!
    expect(updated).not.toBe(queued)
    expect(updated.at(-2)?.id).toBe('reply')
    expect(updated.at(-1)?.pendingSend).toBe('queued')
    previewTicks(updated)

    act(() => {
      probe.session = { ...probe.session!, status: 'ready' }
      setPreview('Idle', { state: 'done' })
    })
    const idle = probe.inputs.at(-1)!
    expect(idle).not.toBe(updated)
    previewTicks(idle, { state: 'done' })

    const retired = [
      ...caughtUp,
      { ...message('follow-up', 'user', 'Follow up'), timestamp: 1_001 },
      { ...message('next-reply', 'assistant', 'Done'), timestamp: 1_002 }
    ]
    act(() => {
      probe.session = { ...probe.session!, messages: retired }
      setPreview('Done', { state: 'done' })
    })
    previewTicks(retired, { state: 'done' })
  })
})
