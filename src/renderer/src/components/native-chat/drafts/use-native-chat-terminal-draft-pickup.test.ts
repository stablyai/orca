// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLaunchDraft } from '@/components/native-chat/drafts/native-chat-launch-prompt'
import { useNativeChatTerminalDraftPickup } from './use-native-chat-terminal-draft-pickup'

const mocks = vi.hoisted(() => {
  const launchDrafts: Record<string, NativeChatLaunchDraft> = {}
  return {
    seedNativeChatLaunchDraft: vi.fn(),
    resolveNativeChatLaunchDraft: vi.fn(),
    launchDrafts
  }
})

vi.mock('../../../store/index', () => ({
  useAppStore: {
    getState: () => ({
      nativeChatLaunchDraftByTabId: mocks.launchDrafts,
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      resolveNativeChatLaunchDraft: mocks.resolveNativeChatLaunchDraft
    })
  }
}))

function seed(overrides: Partial<NativeChatLaunchDraft> = {}): NativeChatLaunchDraft {
  return {
    tabId: 'tab-1',
    agent: 'claude',
    text: 'look at the flaky retry test',
    createdAt: 1_000,
    fromTerminal: true,
    ...overrides
  }
}

describe('useNativeChatTerminalDraftPickup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.launchDrafts = {}
  })

  type Props = {
    launchDraft: NativeChatLaunchDraft | null
    resolved: boolean
    transcriptReady: boolean
  }

  function render(initialProps: Props) {
    const readTerminalDraft = vi.fn(() => 'typed in the terminal')
    const hook = renderHook(
      (props: Props) =>
        useNativeChatTerminalDraftPickup({
          terminalTabId: 'tab-1',
          agent: 'claude',
          launchSeed: {
            launchDraft: props.launchDraft,
            launchDraftResolved: props.resolved,
            transcriptReady: props.transcriptReady,
            ownsTabWideLaunchDraft: true,
            readTerminalDraft
          }
        }),
      { initialProps }
    )
    return { hook, readTerminalDraft }
  }

  const orcaDraft = seed({ fromTerminal: undefined })

  it('reads the line once the transcript shows a draft Orca typed was already sent', () => {
    const { hook, readTerminalDraft } = render({
      launchDraft: orcaDraft,
      resolved: false,
      transcriptReady: false
    })
    expect(readTerminalDraft).not.toHaveBeenCalled()

    hook.rerender({ launchDraft: orcaDraft, resolved: true, transcriptReady: true })
    expect(readTerminalDraft).toHaveBeenCalledTimes(1)
    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'typed in the terminal', fromTerminal: true })
    )
  })

  it('never reads after a chat send takes the Orca draft before the transcript is ready', () => {
    const { hook, readTerminalDraft } = render({
      launchDraft: orcaDraft,
      resolved: false,
      transcriptReady: false
    })
    // The send drops the seed at once, while its clear may not have reached the terminal yet.
    hook.rerender({ launchDraft: null, resolved: false, transcriptReady: false })
    hook.rerender({ launchDraft: null, resolved: false, transcriptReady: true })

    expect(readTerminalDraft).not.toHaveBeenCalled()
  })
})
