// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatToolRun } from './NativeChatToolRun'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'

vi.mock('./NativeChatDiffCard', () => ({ NativeChatDiffCard: () => null }))
vi.mock('./NativeChatDiffView', () => ({ NativeChatDiffView: () => null }))

const disclosureWrite = vi.fn()
const capturedDisclosures = {
  read: (_key: string) => undefined,
  write: (key: string, open: boolean) => disclosureWrite(key, open)
}

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

function ToolRunDisclosureHarness({ expandOverride }: { expandOverride: boolean }) {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatToolRun
        blocks={[shell]}
        expandSignal={false}
        expandOverride={expandOverride}
        activeTurnIsWorking={false}
        disclosureId="message-1"
      />
    </NativeChatDisclosureContext.Provider>
  )
}

describe('inline tool annotations', () => {
  it('restores a per-run deviation when its turn returns to the same disclosure state', () => {
    const { rerender } = render(<ToolRunDisclosureHarness expandOverride />)
    const run = screen.getByRole('button', { expanded: true })

    fireEvent.click(run)
    expect(run.getAttribute('aria-expanded')).toBe('false')

    rerender(<ToolRunDisclosureHarness expandOverride={false} />)
    expect(screen.queryByRole('button')).toBeNull()

    rerender(<ToolRunDisclosureHarness expandOverride />)
    expect(screen.getByRole('button', { name: /1×/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('resynchronizes a standalone run when the toolbar signal flips', () => {
    const { rerender } = render(
      <NativeChatToolRun blocks={[shell]} expandSignal={false} activeTurnIsWorking={false} />
    )
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')

    rerender(<NativeChatToolRun blocks={[shell]} expandSignal activeTurnIsWorking={false} />)

    expect(screen.getByRole('button', { name: /1×/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('uses provider call identities for byte-identical line disclosure keys', () => {
    const blocks = [
      { ...shell, callId: 'call-a' },
      { ...shell, callId: 'call-b' }
    ]
    render(
      <NativeChatDisclosureContext.Provider value={capturedDisclosures}>
        <NativeChatToolRun blocks={blocks} expandSignal disclosureId="message-1" />
      </NativeChatDisclosureContext.Provider>
    )

    fireEvent.click(screen.getAllByRole('button')[2]!)

    expect(disclosureWrite).toHaveBeenCalledExactlyOnceWith('line:message-1:call:call-b', false)
  })

  it('keeps occurrence identity as the fallback for calls without provider IDs', () => {
    render(
      <NativeChatDisclosureContext.Provider value={capturedDisclosures}>
        <NativeChatToolRun blocks={[shell, shell]} expandSignal disclosureId="message-1" />
      </NativeChatDisclosureContext.Provider>
    )

    fireEvent.click(screen.getAllByRole('button')[2]!)

    expect(disclosureWrite).toHaveBeenCalledExactlyOnceWith(
      'line:message-1:tool-call:shell:{"command":"missing-command"}:1',
      false
    )
  })

  it('keeps command completion annotations on the collapsed tool line', () => {
    render(
      <NativeChatToolRun
        blocks={[shell]}
        expandSignal={false}
        expandOverride
        activeTurnIsWorking={false}
      />
    )
    expect(screen.getByText('exit 127').closest('button')).toBe(
      screen.getByText('400ms').closest('button')
    )
    expect(screen.getByText('exit 127').closest('button')?.getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByText('0s')).toBeNull()
  })
  it('renders a legacy command without invented metadata', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'shell', input: null }]}
        expandSignal
      />
    )
    expect(screen.queryByText(/exit \d/)).toBeNull()
    expect(screen.queryByText(/\d+ms/)).toBeNull()
  })
  it('shows distinct MCP names while retaining the raw identifier', () => {
    const name = 'mcp__linear__list_issues'
    render(<NativeChatToolRun blocks={[{ type: 'tool-call', name, input: null }]} expandSignal />)
    expect(screen.getByText('Linear')).toBeTruthy()
    expect(screen.getByText('list issues')).toBeTruthy()
    expect(screen.getByTitle(name)).toBeTruthy()
  })
  it('reveals safe result links only inside row disclosure and routes clicks through chat', () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const block: NativeChatToolCallBlock = {
      type: 'tool-call',
      name: 'web_search',
      input: { query: 'docs' },
      state: 'completed',
      webSearchResults: [{ title: 'Reference docs', url: 'https://example.com/docs' }]
    }
    render(
      <NativeChatToolRun
        blocks={[block]}
        expandSignal={false}
        expandOverride
        onLinkClick={onLinkClick}
      />
    )
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByText('web_search', { selector: 'code' }).closest('button')!)
    const link = screen.getByRole('link', { name: /Reference docs/ })
    expect(link.getAttribute('href')).toBe('https://example.com/docs')
    expect(link.closest('button')).toBeNull()
    fireEvent.click(link)
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'https://example.com/docs')
    fireEvent(link, new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(onLinkClick).toHaveBeenCalledTimes(2)
  })
})

it.each(['tools/read', 'browser.open', 'package.lock', 'linear/list_issues'])(
  'keeps an ordinary tool name %s intact',
  (name) => {
    render(<NativeChatToolRun blocks={[{ type: 'tool-call', name, input: null }]} expandSignal />)
    expect(screen.getByText(name, { selector: 'code' })).toBeTruthy()
    expect(document.querySelector('.lucide-plug')).toBeNull()
  }
)

it.each(['running', 'completed'] as const)(
  'renders provider MCP identity on %s rows and headers',
  (state) => {
    const name = 'my_server/ns.tool'
    render(
      <NativeChatToolRun
        blocks={[
          {
            type: 'tool-call',
            name,
            input: null,
            state,
            mcpIdentity: { server: 'my_server', tool: 'ns.tool' }
          }
        ]}
        expandSignal
        activeTurnIsWorking={state === 'running'}
      />
    )
    expect(screen.getByText('My server')).toBeTruthy()
    expect(screen.getByText('ns.tool')).toBeTruthy()
    expect(screen.getByTitle(name)).toBeTruthy()
    // Header glyph plus the row's. A settled header also names each member in a
    // pill, which carries that member's own glyph — so three, all plug: the
    // identity holds wherever it is drawn.
    expect(document.querySelectorAll('.lucide-plug')).toHaveLength(state === 'completed' ? 3 : 2)
  }
)

it.each([
  [{ exitCode: 0 }, 'exit 0', '400ms'],
  [{ durationMs: 400 }, '400ms', 'exit 0']
])('renders independently optional command metadata %j', (metadata, present, absent) => {
  render(
    <NativeChatToolRun
      blocks={[{ type: 'tool-call', name: 'shell', input: null, ...metadata }]}
      expandSignal
    />
  )
  expect(screen.getByText(present)).toBeTruthy()
  expect(screen.queryByText(absent)).toBeNull()
})

it('filters untrusted persisted result URLs at the renderer boundary', () => {
  const onLinkClick = vi.fn((event) => event.preventDefault())
  render(
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
      onLinkClick={onLinkClick}
    />
  )
  const links = screen.getAllByRole('link')
  expect(links).toHaveLength(1)
  fireEvent.click(links[0]!)
  expect(onLinkClick).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'https://example.com/docs')
})
