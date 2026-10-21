// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import { MessageRow } from './NativeChatMessageRow'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const LONG_TEXT = Array(40).fill('line').join('\n')

function prompt(id: string, text = LONG_TEXT): NativeChatMessage {
  return { id, role: 'user', timestamp: 0, source: 'transcript', blocks: [{ type: 'text', text }] }
}

/** happy-dom lays nothing out, so the prompt's full height against its clip is supplied. */
function renderPrompt(initial: NativeChatMessage, fullHeightPx = 800) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(fullHeightPx)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(176)
  function Transcript({ message }: { message: NativeChatMessage | null }) {
    const disclosures = useNativeChatDisclosures()
    return (
      <TooltipProvider>
        <NativeChatDisclosureContext.Provider value={disclosures}>
          {message ? (
            <MessageRow message={message} expandSignal={false} onScrollMessageToTop={vi.fn()} />
          ) : null}
        </NativeChatDisclosureContext.Provider>
      </TooltipProvider>
    )
  }
  const view = render(<Transcript message={initial} />)
  return {
    show: (message: NativeChatMessage | null) => view.rerender(<Transcript message={message} />)
  }
}

const folded = () => document.querySelector('[data-native-chat-user-message-folded]')
const showFull = () => screen.queryByRole('button', { name: 'Show full message' })
const showLess = () => screen.queryByRole('button', { name: 'Show less' })

describe('a long sent prompt', () => {
  it.each([
    ['8 lines', Array(8).fill('line').join('\n'), false],
    ['9 lines', Array(9).fill('line').join('\n'), true],
    ['600 characters', 'x'.repeat(600), false],
    ['601 characters', 'x'.repeat(601), true]
  ])('at %s, folds: %s', (_label, text, folds) => {
    renderPrompt(prompt('prompt', text))
    expect(folded() !== null).toBe(folds)
    expect(showFull() !== null).toBe(folds)
  })

  it('opens and folds again', () => {
    renderPrompt(prompt('prompt'))
    fireEvent.click(showFull()!)
    expect(folded()).toBeNull()

    fireEvent.click(showLess()!)
    expect(folded()).not.toBeNull()
    expect(showFull()).toBeInTheDocument()
  })

  it('shows no fade or toggle when a long text already fits its preview', () => {
    renderPrompt(prompt('prompt'), 150)
    expect(folded()).toBeNull()
    expect(showFull()).toBeNull()
  })

  it('measures again when a longer copy of the message replaces one that fit', () => {
    const { show } = renderPrompt(prompt('prompt'), 150)
    expect(showFull()).toBeNull()

    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(800)
    show(prompt('prompt', `${LONG_TEXT}\nmore`))
    expect(folded()).not.toBeNull()
    expect(showFull()).toBeInTheDocument()
  })

  it('stays open after its row leaves the window and returns', () => {
    const { show } = renderPrompt(prompt('prompt'))
    fireEvent.click(showFull()!)
    show(null)
    show(prompt('prompt'))
    expect(folded()).toBeNull()
    expect(showLess()).toBeInTheDocument()
  })
})
