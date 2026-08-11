import { Terminal } from '@xterm/headless'
import type { ILink, Terminal as XtermTerminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  createOsc8CursorPositionedLinkProvider,
  registerFirstLinkProvider
} from './osc8-cursor-positioned-link-provider'
import { createOsc8LinkUrlCache } from './osc8-link-url-cache'

const COLS = 110
const URL = 'https://github.com/stablyai/orca/pull/10349#issuecomment-5068238223'
const OPEN = `]8;id=42;${URL}`
const CLOSE = ']8;;'

// A TUI that lays out its own block width emits each row separately, so xterm
// records no `isWrapped` flag even though one link spans both rows.
const WRAPPED_ROWS = [
  `10349 (${OPEN}https://github.com/stablyai/orca/${CLOSE}`,
  `${OPEN}pull/10349#issuecomment-5068238223${CLOSE}) done`
]

async function writeRows(terminal: Terminal, rows: string[]): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(rows.join('\r\n'), () => resolve()))
}

/** Cache must observe the stream, so create it before writing. */
function newTerminal(): { terminal: Terminal; cache: ReturnType<typeof createOsc8LinkUrlCache> } {
  const terminal = new Terminal({ cols: COLS, rows: 20, allowProposedApi: true })
  const cache = createOsc8LinkUrlCache(terminal as unknown as XtermTerminal)
  return { terminal, cache }
}

function providerFor(
  terminal: Terminal,
  cache = createOsc8LinkUrlCache(terminal as unknown as XtermTerminal)
) {
  const xterm = terminal as unknown as XtermTerminal
  const onActivate = vi.fn()
  const onHover = vi.fn()

  const provider = createOsc8CursorPositionedLinkProvider({
    getTerminal: () => xterm,
    getLinkUrl: (urlId) => cache.get(urlId),
    onActivate,
    onHover,
    onLeave: vi.fn()
  })

  const provideAt = (bufferLineNumber: number): ILink[] | undefined => {
    let links: ILink[] | undefined
    provider.provideLinks(bufferLineNumber, (result) => {
      links = result
    })
    return links
  }

  return { provideAt, onActivate, onHover, cache }
}

describe('OSC 8 cursor-positioned link provider', () => {
  it.each([
    ['the row bearing the scheme', 1],
    ['the continuation row', 2]
  ])('spans both rows when hovering %s', async (_label, bufferLineNumber) => {
    const { terminal, cache } = newTerminal()
    await writeRows(terminal, WRAPPED_ROWS)
    // Neither row is soft-wrapped, which is why xterm's own provider stops short.
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false)

    const { provideAt } = providerFor(terminal, cache)

    const links = provideAt(bufferLineNumber)

    expect(links).toHaveLength(1)
    expect(links?.[0].text).toBe(URL)
    expect(links?.[0].range.start.y).toBe(1)
    expect(links?.[0].range.end.y).toBe(2)
    terminal.dispose()
  })

  it('starts the range at the scheme, not the row start', async () => {
    const { terminal, cache } = newTerminal()
    await writeRows(terminal, WRAPPED_ROWS)
    const { provideAt } = providerFor(terminal, cache)

    // `10349 (` precedes the link, so the run starts at column 8 (1-based).
    expect(provideAt(1)?.[0].range.start.x).toBe(8)
    terminal.dispose()
  })

  it('activates and hovers with the whole URL from the continuation row', async () => {
    const { terminal, cache } = newTerminal()
    await writeRows(terminal, WRAPPED_ROWS)
    const { provideAt, onActivate, onHover } = providerFor(terminal, cache)

    const link = provideAt(2)![0]
    link.activate({} as MouseEvent, link.text)
    link.hover?.({} as MouseEvent, link.text)

    expect(onActivate).toHaveBeenCalledWith(expect.anything(), URL, link.range)
    expect(onHover).toHaveBeenCalledWith(expect.anything(), URL, link.range)
    terminal.dispose()
  })

  it('leaves single-row links to xterm’s own provider', async () => {
    const { terminal, cache } = newTerminal()
    await writeRows(terminal, [`see ${OPEN}${URL}${CLOSE} done`])
    const { provideAt } = providerFor(terminal, cache)

    expect(provideAt(1)).toBeUndefined()
    terminal.dispose()
  })

  it('does not join adjacent links that carry different ids', async () => {
    const { terminal, cache } = newTerminal()
    const other = 'https://example.com/other'
    await writeRows(terminal, [
      `${OPEN}https://github.com/stablyai/orca/${CLOSE}`,
      `]8;id=99;${other}${other}${CLOSE}`
    ])
    const { provideAt } = providerFor(terminal, cache)

    // Row 1's run reaches the row end but row 2 belongs to a different link.
    expect(provideAt(1)).toBeUndefined()
    terminal.dispose()
  })

  // Why: xterm's linkifier takes the FIRST provider that matches, and it
  // registers its own OSC 8 provider at construction — so a later registration
  // could never win and the hover kept showing the single-row range.
  it('registers ahead of xterm’s own OSC 8 provider', () => {
    const builtIn = { provideLinks: vi.fn() }
    const linkProviders: unknown[] = [builtIn]
    // Orca wraps providers in an error guard before registering, so the array
    // holds a wrapper rather than the provider object itself.
    const stub = {
      registerLinkProvider: (p: { provideLinks: unknown }) => {
        const guarded = { provideLinks: p.provideLinks }
        linkProviders.push(guarded)
        return {
          dispose: () => {
            linkProviders.splice(linkProviders.indexOf(guarded), 1)
          }
        }
      },
      _core: { _linkProviderService: { linkProviders } }
    }
    const provider = createOsc8CursorPositionedLinkProvider({
      getTerminal: () => null,
      getLinkUrl: () => URL,
      onActivate: vi.fn(),
      onHover: vi.fn(),
      onLeave: vi.fn()
    })

    const disposable = registerFirstLinkProvider(stub as unknown as XtermTerminal, provider)

    expect(linkProviders[0]).not.toBe(builtIn)
    expect(linkProviders.indexOf(builtIn)).toBe(1)

    disposable.dispose()
    expect(linkProviders).toEqual([builtIn])
  })
})
