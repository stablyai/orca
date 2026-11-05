// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatToolRun } from './NativeChatToolRun'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import { openToolRunMembers } from './native-chat-tool-run-members-test-support'
import { NativeChatLinkClickContext } from './native-chat-link-click-context'

vi.mock('./NativeChatDiffCard', () => ({ NativeChatDiffCard: () => null }))
vi.mock('./NativeChatDiffView', () => ({ NativeChatDiffView: () => null }))

const disclosureWrite = vi.fn()

afterEach(() => {
  cleanup()
  disclosureWrite.mockReset()
})

const shell: NativeChatToolCallBlock = {
  type: 'tool-call',
  name: 'shell',
  input: { command: 'missing-command' },
  state: 'failed',
  exitCode: 127,
  durationMs: 400
}

function ToolRunDisclosureHarness({ expandSignal }: { expandSignal: boolean }) {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatToolRun
        blocks={[shell]}
        expandSignal={expandSignal}
        activeTurnIsWorking={false}
        disclosureId="message-1"
      />
    </NativeChatDisclosureContext.Provider>
  )
}

describe('inline tool annotations', () => {
  it('restores a per-run deviation when its turn returns to the same disclosure state', () => {
    const { rerender } = render(<ToolRunDisclosureHarness expandSignal />)
    const run = screen.getByRole('button', { expanded: true })

    fireEvent.click(run)
    expect(run.getAttribute('aria-expanded')).toBe('false')

    rerender(<ToolRunDisclosureHarness expandSignal={false} />)
    fireEvent.click(screen.getByRole('button', { name: /missing-command/ }))

    rerender(<ToolRunDisclosureHarness expandSignal />)
    expect(
      screen.getByRole('button', { name: /missing-command/ }).getAttribute('aria-expanded')
    ).toBe('false')
  })
})

it('filters untrusted persisted result URLs at the renderer boundary', () => {
  const onLinkClick = vi.fn((event) => event.preventDefault())
  render(
    <NativeChatLinkClickContext value={onLinkClick}>
      <NativeChatToolRun
        blocks={[
          {
            type: 'tool-call',
            name: 'web_search',
            input: null,
            webSearchResults: [
              { title: 'Script', url: 'javascript:alert(1)' },
              { title: 'Local file', url: 'file:///tmp/secret' },
              { title: 'App route', url: 'orca://open' },
              { title: 'Protocol relative', url: '//example.com' },
              { title: 'Data', url: 'data:text/html,hello' },
              { title: 'Docs', url: 'https://example.com/docs' }
            ]
          }
        ]}
        expandSignal
      />
    </NativeChatLinkClickContext>
  )
  openToolRunMembers()
  const links = screen.getAllByRole('link')
  expect(links).toHaveLength(1)
  fireEvent.click(links[0]!)
  expect(onLinkClick).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'https://example.com/docs')
})
