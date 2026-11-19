// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import { useNativeChatSurface, type NativeChatSurfaceArgs } from './use-native-chat-surface'
import { NativeChatSurface, NativeChatSurfaceFindBar } from './NativeChatSurface'

vi.mock('./selection-quotes/NativeChatSelectionQuote', () => ({
  NativeChatSelectionQuote: () => null
}))

const typed: string[] = []
const composer: NativeChatComposerHandle = {
  focus: () => true,
  insertAgentReferences: () => false,
  insertTypedText: (text) => (typed.push(text), true),
  appendText: () => {},
  acceptsText: () => true,
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false
}

afterEach(() => {
  cleanup()
  typed.length = 0
})

function Chat(props: Pick<NativeChatSurfaceArgs, 'onSplit' | 'onPointerDownCapture'>) {
  const composerRef = useRef<NativeChatComposerHandle | null>(composer)
  const transcriptRef = useRef({ revealFindMatch: () => {} })
  const surface = useNativeChatSurface({
    tabId: 'chat-tab',
    sessionId: 'session-1',
    isVisible: true,
    isFocusedGroup: true,
    composerRef,
    transcriptRef,
    fileLinkContext: null,
    composerReady: true,
    conversationShown: true,
    ...props
  })
  return (
    <NativeChatSurface surface={surface} working={false}>
      <NativeChatSurfaceFindBar surface={surface} isVisible />
      <div data-testid="transcript" tabIndex={0}>
        Reply text
      </div>
    </NativeChatSurface>
  )
}

function renderChat(props: Parameters<typeof Chat>[0] = {}) {
  return render(
    <TooltipProvider>
      <Chat {...props} />
    </TooltipProvider>
  )
}

const mac = getShortcutPlatform() === 'darwin'
const splitRight = { key: 'd', code: 'KeyD', metaKey: mac, ctrlKey: !mac, shiftKey: !mac }

it('types into the composer from anywhere in the chat', () => {
  renderChat()
  fireEvent.keyDown(screen.getByTestId('transcript'), { key: 'h' })
  expect(typed).toEqual(['h'])
})

it('opens Find from the chat menu', async () => {
  renderChat()
  fireEvent.contextMenu(screen.getByTestId('transcript'), { clientX: 4, clientY: 4 })
  fireEvent.click(await screen.findByRole('menuitem', { name: /Find in chat/ }))
  expect(await screen.findByRole('textbox', { name: 'Find in chat' })).toBeTruthy()
})

it('a split key the screen runs is consumed; one it declines reaches the app', () => {
  const onSplit = vi.fn(() => true)
  const view = renderChat({ onSplit })
  const transcript = screen.getByTestId('transcript')
  expect(fireEvent.keyDown(transcript, splitRight)).toBe(false)
  expect(onSplit).toHaveBeenCalledWith('right')

  onSplit.mockReturnValue(false)
  expect(fireEvent.keyDown(transcript, splitRight)).toBe(true)
  view.unmount()

  renderChat()
  expect(fireEvent.keyDown(screen.getByTestId('transcript'), splitRight)).toBe(true)
})

it('runs the screen pointer step on a press', () => {
  const onPointerDownCapture = vi.fn()
  renderChat({ onPointerDownCapture })
  fireEvent.pointerDown(screen.getByTestId('transcript'), { button: 2 })
  expect(onPointerDownCapture).toHaveBeenCalledOnce()
})
