import type { ILink, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalSuggestedCommandLinkProvider,
  runTerminalSuggestedCommand
} from './terminal-suggested-command-links'
import type { TerminalLinkActionContext } from '../terminal-link-action-request'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const COLS = 40

function makeTerminal(rows: string[], cursorY: number) {
  const lines = rows.map((text) => {
    const padded = text.padEnd(COLS, ' ')
    return {
      isWrapped: false,
      length: COLS,
      translateToString: (
        _trimRight?: boolean,
        start = 0,
        end = padded.length,
        outColumns?: number[]
      ) => {
        outColumns?.push(...Array.from({ length: padded.length + 1 }, (_value, index) => index))
        return padded.slice(start, end)
      }
    }
  })
  const terminal = {
    buffer: { active: { baseY: 0, cursorY, getLine: (y: number) => lines[y] } },
    modes: { bracketedPasteMode: true },
    options: { ignoreBracketedPasteMode: false },
    paste: vi.fn(),
    input: vi.fn(),
    element: { isConnected: true },
    focus: vi.fn(),
    clearSelection: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider reads only the buffer, paste, input, focus and selection members stubbed above.
  return terminal as typeof terminal & Terminal
}

const tooltip = { textContent: '', style: { display: 'none' } }

function provide(
  terminal: Terminal | null,
  lineNumber: number,
  options: {
    getTerminal?: () => Terminal | null
    getLinkActionContext?: () => TerminalLinkActionContext | null
  } = {}
): ILink[] | undefined {
  const provider = createTerminalSuggestedCommandLinkProvider({
    getTerminal: options.getTerminal ?? (() => terminal),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider only writes textContent and style.display.
    linkTooltip: tooltip as unknown as HTMLElement,
    getLinkActionContext: options.getLinkActionContext
  })
  let links: ILink[] | undefined
  provider.provideLinks(lineNumber, (result) => {
    links = result
  })
  return links
}

describe('terminal suggested command links', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pastes the command and presses Enter in a separate write', () => {
    const terminal = makeTerminal([], 0)

    runTerminalSuggestedCommand(terminal, '! git status')

    expect(terminal.paste).toHaveBeenCalledWith('! git status')
    expect(terminal.input).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(terminal.input).toHaveBeenCalledWith('\r')
  })

  it('links every row of a wrapped command and runs it on modifier-click', () => {
    const terminal = makeTerminal(
      [
        '  ! ssh deploy@db.example.com "mysql" <',
        '  /tmp/check.sql > /tmp/out; wc -l out',
        '',
        '> '
      ],
      3
    )

    const links = provide(terminal, 2)
    expect(links).toHaveLength(1)
    expect(links?.[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 38, y: 2 } })

    const isMac = navigator.userAgent.includes('Mac')
    const click = { button: 0, metaKey: isMac, ctrlKey: !isMac, preventDefault: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activation reads only the button, modifier and preventDefault members.
    links?.[0].activate(click as unknown as MouseEvent, links[0].text)
    expect(terminal.paste).toHaveBeenCalledWith(
      '! ssh deploy@db.example.com "mysql" < /tmp/check.sql > /tmp/out; wc -l out'
    )
  })

  it('does not run when the row was repainted after the link was offered', () => {
    const rows = ['  ! git status']
    const terminal = makeTerminal(rows, 3)
    const links = provide(terminal, 1)
    const replaced = makeTerminal(['  ! git push --force'], 3)
    terminal.buffer.active.getLine = replaced.buffer.active.getLine

    const isMac = navigator.userAgent.includes('Mac')
    const click = { button: 0, metaKey: isMac, ctrlKey: !isMac, preventDefault: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activation reads only the button, modifier and preventDefault members.
    links?.[0].activate(click as unknown as MouseEvent, links[0].text)
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('does not run once the setting turns off while the link is offered', () => {
    const terminal = makeTerminal(['  ! git status'], 3)
    let enabled = true
    const links = provide(terminal, 1, { getTerminal: () => (enabled ? terminal : null) })
    enabled = false

    const isMac = navigator.userAgent.includes('Mac')
    const click = { button: 0, metaKey: isMac, ctrlKey: !isMac, preventDefault: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activation reads only the button, modifier and preventDefault members.
    links?.[0].activate(click as unknown as MouseEvent, links[0].text)
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('advertises the popover only when a plain click opens it', () => {
    const terminal = makeTerminal(['  ! git status'], 3)
    const context = (plainClickBehavior: 'actions' | 'open'): TerminalLinkActionContext =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hover hint reads only plainClickBehavior.
      ({ plainClickBehavior }) as TerminalLinkActionContext

    provide(terminal, 1, { getLinkActionContext: () => context('open') })?.[0].hover?.(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hover ignores the event.
      {} as MouseEvent,
      ''
    )
    expect(tooltip.textContent).not.toContain('Click for actions')
    provide(terminal, 1, { getLinkActionContext: () => context('actions') })?.[0].hover?.(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hover ignores the event.
      {} as MouseEvent,
      ''
    )
    expect(tooltip.textContent).toContain('Click for actions')
  })

  it('offers nothing on the prompt row or when the setting turns links off', () => {
    const terminal = makeTerminal(['  ! git status'], 0)

    expect(provide(terminal, 1)).toBeUndefined()
    expect(provide(null, 1)).toBeUndefined()
  })
})
