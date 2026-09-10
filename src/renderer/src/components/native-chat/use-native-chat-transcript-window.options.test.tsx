// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createReactVirtualModuleMock,
  type ReactVirtualizerOptionsCapture
} from '../sidebar/worktree-list-lineage-card-test-harness'

const virtualizerOptions = vi.hoisted<ReactVirtualizerOptionsCapture>(() => ({ current: null }))

vi.mock('@tanstack/react-virtual', () => createReactVirtualModuleMock(virtualizerOptions))

const { useNativeChatTranscriptWindow } = await import('./use-native-chat-transcript-window')

afterEach(() => {
  cleanup()
  virtualizerOptions.current = null
})

describe('native chat transcript virtualizer contract', () => {
  it('configures prepend anchoring and matching bottom-follow behavior', () => {
    renderHook(() =>
      useNativeChatTranscriptWindow({
        scrollRef: { current: null },
        slots: [],
        revealIndex: -1
      })
    )

    expect(virtualizerOptions.current).toMatchObject({
      anchorTo: 'end',
      followOnAppend: true,
      scrollEndThreshold: 48
    })
  })
})
