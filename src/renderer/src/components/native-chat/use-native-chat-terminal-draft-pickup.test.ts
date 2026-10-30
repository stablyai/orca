// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import {
  planNativeChatTerminalDraftPickup,
  useNativeChatTerminalDraftPickup
} from './use-native-chat-terminal-draft-pickup'

const mocks = vi.hoisted(() => {
  const launchDrafts: Record<string, NativeChatLaunchDraft> = {}
  return {
    seedNativeChatLaunchDraft: vi.fn(),
    resolveNativeChatLaunchDraft: vi.fn(),
    launchDrafts
  }
})

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      nativeChatLaunchDraftByTabId: mocks.launchDrafts,
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      resolveNativeChatLaunchDraft: mocks.resolveNativeChatLaunchDraft
    })
  }
}))

const NOW = 5_000

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

function plan(current: NativeChatLaunchDraft | null, terminalText: string | null) {
  return planNativeChatTerminalDraftPickup({
    tabId: 'tab-1',
    agent: 'claude',
    current,
    terminalText,
    now: NOW
  })
}

describe('planNativeChatTerminalDraftPickup', () => {
  it('seeds unsent terminal text so a send replaces every line of it', () => {
    expect(plan(null, 'alpha\nbeta')).toEqual({
      kind: 'seed',
      draft: {
        tabId: 'tab-1',
        agent: 'claude',
        text: 'alpha\nbeta',
        createdAt: NOW,
        fromTerminal: true
      }
    })
  })

  it('keeps the seed while the terminal still holds its text', () => {
    expect(plan(seed({ adopted: true }), 'look at the flaky retry test')).toEqual({ kind: 'none' })
  })

  it('replaces an adopted seed edited in the terminal, naming the copy it replaces', () => {
    const result = plan(seed({ adopted: true }), 'look at the flaky retry test now')
    expect(result).toMatchObject({
      kind: 'seed',
      draft: {
        text: 'look at the flaky retry test now',
        replacesText: 'look at the flaky retry test'
      }
    })
  })

  it('resolves the seed once the terminal line is empty', () => {
    const current = seed({ adopted: true })
    expect(plan(current, '')).toEqual({ kind: 'resolve', draft: current })
    // An unreadable line (a dialog over the prompt) proves nothing.
    expect(plan(current, null)).toEqual({ kind: 'none' })
  })

  it('leaves a draft too long to clear in the terminal', () => {
    expect(plan(null, Array.from({ length: 41 }, (_, line) => `line ${line}`).join('\n'))).toEqual({
      kind: 'none'
    })
  })

  it.each(['[Pasted text #1 +29 lines]', 'see [Image #1]', '[Pasted Content 1200 chars]'])(
    'leaves %s in the terminal, since a send would erase what it stands for',
    (label) => {
      expect(plan(null, label)).toEqual({ kind: 'none' })
      // An earlier seed no longer matches the line, so it stops owning the next send's clear.
      const current = seed({ adopted: true })
      expect(plan(current, label)).toEqual({ kind: 'resolve', draft: current })
    }
  )

  it('never resolves a draft Orca typed from an empty read', () => {
    expect(plan(seed({ fromTerminal: undefined }), '')).toEqual({ kind: 'none' })
  })
})

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

  it('reads the input line once per chat-view entry', () => {
    const { hook, readTerminalDraft } = render({
      launchDraft: null,
      resolved: false,
      transcriptReady: false
    })
    hook.rerender({ launchDraft: null, resolved: false, transcriptReady: true })

    expect(readTerminalDraft).toHaveBeenCalledTimes(1)
    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'typed in the terminal', fromTerminal: true })
    )
  })

  it('leaves the line to an unresolved draft Orca typed', () => {
    const { readTerminalDraft } = render({
      launchDraft: orcaDraft,
      resolved: false,
      transcriptReady: true
    })

    expect(readTerminalDraft).not.toHaveBeenCalled()
  })

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
