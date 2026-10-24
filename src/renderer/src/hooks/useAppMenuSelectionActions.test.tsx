// @vitest-environment happy-dom

import { useRef } from 'react'
import { useAppStore } from '@/store'
import { useNativeChatRootInputRouting } from '@/components/native-chat/use-native-chat-root-input-routing'
import type { NativeChatComposerHandle } from '@/components/native-chat/native-chat-composer-types'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'
import { useAppMenuSelectionActions } from './useAppMenuSelectionActions'

let listener: ((action: 'copy' | 'select-all') => void) | null = null
const performNativeSelectionAction = vi.fn()

function Harness(): null {
  useAppMenuSelectionActions()
  return null
}

function TranscriptHarness() {
  useAppMenuSelectionActions()
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle | null>(null)
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  const routing = useNativeChatRootInputRouting({
    tabId: 'selection-chat',
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible: true,
    isFocusedGroup: true,
    composerReady: false
  })
  return (
    <div ref={rootRef} data-native-chat-root onKeyDownCapture={routing.onKeyDownCapture}>
      <div tabIndex={0} data-native-chat-scroll>
        Transcript text
      </div>
      <div data-queued-message-editor>
        <textarea defaultValue="Queued draft" />
      </div>
    </div>
  )
}

beforeEach(() => {
  listener = null
  performNativeSelectionAction.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onAppMenuSelectionAction: vi.fn((callback) => {
          listener = callback
          return () => {
            listener = null
          }
        }),
        performNativeSelectionAction
      }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ unifiedTabsByWorktree: {} })
})

describe('useAppMenuSelectionActions', () => {
  it('falls back to native selection when no Orca surface claims the action', async () => {
    render(<Harness />)

    await act(async () => {
      listener?.('select-all')
    })

    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })

  it('keeps a warm transcript and its selected text as the native Select All owner', async () => {
    useAppStore.setState({
      activeWorktreeId: 'selection-workspace',
      unifiedTabsByWorktree: {
        'selection-workspace': [
          {
            id: 'selection-chat',
            entityId: 'selection-session',
            worktreeId: 'selection-workspace',
            groupId: 'selection-group',
            contentType: 'agent-session',
            agentSessionAgent: 'codex',
            executionHostId: 'local',
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      groupsByWorktree: {
        'selection-workspace': [
          {
            id: 'selection-group',
            worktreeId: 'selection-workspace',
            activeTabId: 'selection-chat',
            tabOrder: ['selection-chat']
          }
        ]
      },
      activeGroupIdByWorktree: { 'selection-workspace': 'selection-group' }
    })
    const { container } = render(<TranscriptHarness />)
    const transcript = container.querySelector<HTMLElement>('[data-native-chat-scroll]')!
    transcript.focus()
    const seen: Element[] = []
    const observe = () => {
      if (document.activeElement) {
        seen.push(document.activeElement)
      }
    }
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, observe)
    await act(async () => listener?.('select-all'))
    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, observe)
    expect(seen).toEqual([transcript])
    expect(document.activeElement).toBe(transcript)
    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })

  it('does not run native selection after a terminal claims the action', () => {
    const claim = (event: Event): void => event.preventDefault()
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, claim)
    render(<Harness />)

    act(() => listener?.('copy'))

    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, claim)
    expect(performNativeSelectionAction).not.toHaveBeenCalled()
  })
})
