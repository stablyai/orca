// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  NO_NATIVE_CHAT_SUBAGENT_SECTIONS,
  type NativeChatSubagentSections
} from './native-chat-subagent-sections'
import {
  nativeChatSubagentRevealTarget,
  useNativeChatSubagentRevealRequest
} from './use-native-chat-subagent-reveal-request'

function row(id: string, blocks: NativeChatMessage['blocks']): { message: NativeChatMessage } {
  return {
    message: {
      id,
      role: 'assistant',
      blocks,
      timestamp: 1,
      source: 'transcript'
    }
  }
}

const say = (text: string): NativeChatMessage['blocks'] => [{ type: 'text', text }]

// `child` is nested under `parent`; its first row draws nothing.
const SECTIONS: NativeChatSubagentSections = {
  ...NO_NATIVE_CHAT_SUBAGENT_SECTIONS,
  rows: new Map([
    ['parent', [{ ...row('p-1', say('Parent')), turnKey: undefined }]],
    [
      'child',
      [
        { ...row('c-0', []), turnKey: undefined },
        { ...row('c-1', say('Child')), turnKey: undefined }
      ]
    ]
  ]),
  pathOf: new Map([
    ['p-1', ['parent']],
    ['c-0', ['parent', 'child']],
    ['c-1', ['parent', 'child']]
  ])
}

describe('nativeChatSubagentRevealTarget', () => {
  it('lands on the first drawn row and opens every enclosing section', () => {
    expect(nativeChatSubagentRevealTarget(SECTIONS, 'child')).toEqual({
      messageId: 'c-1',
      openSections: ['parent', 'child']
    })
  })

  it('finds nothing for a subagent with no loaded rows', () => {
    expect(nativeChatSubagentRevealTarget(SECTIONS, 'unknown')).toBeNull()
  })
})

describe('useNativeChatSubagentRevealRequest', () => {
  let container: HTMLDivElement
  let root: Root
  const openSubagentSections = vi.fn()
  const beginNavigation = vi.fn()
  const requestJump = vi.fn()

  function Probe({ paneKey, ready }: { paneKey: string; ready: boolean }): null {
    useNativeChatSubagentRevealRequest({
      paneKey,
      ready,
      sections: SECTIONS,
      openSubagentSections,
      beginNavigation,
      requestJump
    })
    return null
  }

  function render(props: { paneKey: string; ready: boolean }): void {
    act(() => {
      root.render(<Probe {...props} />)
    })
  }

  function reveal(parentPaneKey: string, agentId: string): void {
    act(() => {
      useAppStore.getState().revealNativeChatSubagent({ parentPaneKey, agentId })
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    useAppStore.setState({ pendingNativeChatSubagentReveal: null })
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('opens the subagent section and jumps to its row once, then clears the request', () => {
    render({ paneKey: 'pane-a', ready: true })
    reveal('pane-a', 'child')

    expect(beginNavigation).toHaveBeenCalledTimes(1)
    expect(openSubagentSections).toHaveBeenCalledWith(['parent', 'child'])
    expect(requestJump).toHaveBeenCalledWith({ id: 'c-1' })
    expect(useAppStore.getState().pendingNativeChatSubagentReveal).toBeNull()

    render({ paneKey: 'pane-a', ready: true })
    expect(requestJump).toHaveBeenCalledTimes(1)
  })

  it('ignores a request for another chat and leaves it pending', () => {
    render({ paneKey: 'pane-a', ready: true })
    reveal('pane-b', 'child')

    expect(requestJump).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingNativeChatSubagentReveal).toEqual({
      parentPaneKey: 'pane-b',
      agentId: 'child'
    })
  })

  it('waits until the chat is ready before serving the request', () => {
    render({ paneKey: 'pane-a', ready: false })
    reveal('pane-a', 'child')
    expect(requestJump).not.toHaveBeenCalled()

    render({ paneKey: 'pane-a', ready: true })
    expect(requestJump).toHaveBeenCalledWith({ id: 'c-1' })
  })

  it('drops a request for a subagent with no loaded rows without moving the reader', () => {
    render({ paneKey: 'pane-a', ready: true })
    reveal('pane-a', 'unknown')

    expect(beginNavigation).not.toHaveBeenCalled()
    expect(openSubagentSections).not.toHaveBeenCalled()
    expect(requestJump).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingNativeChatSubagentReveal).toBeNull()
  })
})
