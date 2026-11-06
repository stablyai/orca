import type { IBufferLine, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  httpLinkActionDestinationsFor,
  type HttpLinkActionDestinations
} from '@/lib/http-link-destinations'
import { usePluginLinkRouteStore } from '@/store/plugin-link-routes'
import type { NormalizedLinkRoute } from '../../../../shared/plugins/contributions/plugin-link-route-matching'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'

// The first physical row parses as a *different, shorter* host than the full link. A route matched
// against WebLinksAddon's truncated `url` would therefore route the wrong site.
const TRUNCATED_ROW = 'https://good.example.com'
const TAIL_ROW = '.evil.test/path'
const COLS = TRUNCATED_ROW.length

function route(host: string, destination: NormalizedLinkRoute['destination']): NormalizedLinkRoute {
  return { pattern: { kind: 'exact', host }, destination, pluginKey: 'demo', index: 0 }
}

function makeBufferLine(fragment: string): IBufferLine {
  const text = fragment.padEnd(COLS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double supplying only the IBufferLine members the hit test reads.
  return {
    isWrapped: false,
    length: COLS,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      outColumns?.splice(
        0,
        outColumns.length,
        ...Array.from({ length: endColumn - startColumn + 1 }, (_v, i) => i + startColumn)
      )
      return text.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

function makeTerminal(): Terminal {
  const rows = [TRUNCATED_ROW, TAIL_ROW]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double supplying only the Terminal members the hit test reads.
  return {
    cols: COLS,
    rows: 10,
    options: { mouseEventsRequireAlt: false },
    element: {
      ownerDocument: { defaultView: { addEventListener: vi.fn(), removeEventListener: vi.fn() } },
      querySelector: () => ({
        getBoundingClientRect: () => ({ left: 0, top: 0, width: COLS * 10, height: 100 })
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    },
    buffer: {
      active: { viewportY: 0, getLine: (y: number) => rows[y] && makeBufferLine(rows[y]) }
    },
    clearSelection: vi.fn()
  } as unknown as Terminal
}

function clickFirstRow(): MouseEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double supplying only the MouseEvent fields the click handler reads.
  return {
    button: 0,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    clientX: 50,
    clientY: 5,
    preventDefault: vi.fn()
  } as unknown as MouseEvent
}

function click(): HttpLinkActionDestinations[] {
  const decided: HttpLinkActionDestinations[] = []
  handleTerminalWebLinkClick(TRUNCATED_ROW, clickFirstRow(), {
    terminal: makeTerminal(),
    worktreeId: 'wt-1',
    worktreePath: '/tmp',
    startupCwd: '/tmp',
    getActionDestinations: (url) => {
      const destinations = httpLinkActionDestinationsFor(
        { openLinksInApp: false },
        { kind: 'local' },
        false,
        url
      )
      decided.push(destinations)
      return destinations
    }
  })
  return decided
}

describe('plugin link routes on hard-wrapped terminal URLs', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('window', { api: { shell: { openUrl: vi.fn(async () => undefined) } } })
    usePluginLinkRouteStore.setState({ routes: [], loaded: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    usePluginLinkRouteStore.setState({ routes: [], loaded: true })
  })

  it('ignores a route matching only the host the physical row is truncated to', () => {
    usePluginLinkRouteStore.setState({ routes: [route('good.example.com', 'orca-browser')] })

    expect(click()).toEqual([{ primary: 'system', alternate: 'orca' }])
  })

  it('routes on the reconstructed host of the complete URL', () => {
    usePluginLinkRouteStore.setState({
      routes: [route('good.example.com.evil.test', 'orca-browser')]
    })

    expect(click()).toEqual([{ primary: 'orca', alternate: 'system' }])
  })

  // Cold-click window: the table is fetched async, so early clicks see [] and must keep today's behavior.
  it('falls back to the settings default while the route table is still empty', () => {
    expect(click()).toEqual([{ primary: 'system', alternate: 'orca' }])
  })
})

describe('httpLinkActionDestinationsFor with plugin routes', () => {
  afterEach(() => {
    usePluginLinkRouteStore.setState({ routes: [], loaded: true })
  })

  it('never lets a route promote a remote link the source cannot open in Orca', () => {
    usePluginLinkRouteStore.setState({ routes: [route('app.example.com', 'orca-browser')] })

    expect(
      httpLinkActionDestinationsFor(
        { openLinksInApp: true },
        { kind: 'ssh', connectionId: 'conn-1' },
        false,
        'https://app.example.com/'
      )
    ).toEqual({ primary: 'system' })
  })
})
