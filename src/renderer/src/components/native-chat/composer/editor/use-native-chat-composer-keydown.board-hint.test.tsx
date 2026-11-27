// @vitest-environment happy-dom

import React, { StrictMode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import SidebarToolbar from '../../../sidebar/chrome/SidebarToolbar'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function Composer({ interrupt }: { interrupt: () => void }): React.JSX.Element {
  const onKeyDown = useNativeChatComposerKeyDown({
    autocomplete: { mode: 'none' },
    mentionFiles: { files: [], loading: false, failed: false },
    completeMention: () => {},
    activeSuggestion: 0,
    draft: '',
    isComposing: () => false,
    completePickerItem: () => {},
    dispatchPickerCommand: () => {},
    dismissPicker: () => {},
    interrupt,
    send: () => {},
    setActiveSuggestion: () => {},
    setDraft: () => {},
    setCaret: () => {}
  })
  return <textarea aria-label="Message" onKeyDown={onKeyDown} />
}

it('stops a running turn on Escape while the "board moved" hint shows', () => {
  useAppStore.setState({
    persistedUIReady: true,
    featureInteractions: { 'workspace-board': { firstInteractedAt: 1, interactionCount: 1 } },
    workspaceBoardUsedBeforeLaunch: true
  })
  const interrupt = vi.fn()
  render(
    <StrictMode>
      <TooltipProvider>
        <SidebarToolbar workspaceBoardOpen={false} onWorkspaceBoardToggle={() => {}} />
        <Composer interrupt={interrupt} />
      </TooltipProvider>
    </StrictMode>
  )
  // Matches the hint bubble, or the forced-open tooltip it replaced.
  const hint = Array.from(
    document.querySelectorAll('[data-workspace-board-moved-hint], [data-slot="tooltip-content"]')
  ).find((bubble) => bubble.textContent?.includes('Workspace board moved to the bottom bar'))
  expect(hint).toBeDefined()
  expect(hint?.getAttribute('data-state')).not.toBe('closed')

  const composer = screen.getByRole('textbox', { name: 'Message' })
  composer.focus()
  act(() => {
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
  expect(interrupt).toHaveBeenCalledTimes(1)
})
