import type { IBufferLine, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { httpLinkActionDestinationsFor } from '@/lib/http-link-destinations'
import { usePluginLinkRouteStore } from '@/store/plugin-link-routes'
import type { NormalizedLinkRoute } from '../../../../shared/plugins/plugin-link-route-matching'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'

// The first physical row parses as a *different, shorter* host than the full link. A route matched
// against WebLinksAddon's truncated `url` would therefore route the wrong site.
const TRUNCATED_ROW = 'https://good.example.com'
const TAIL_ROW = '.evil.test/path'
const FULL_URL = `${TRUNCATED_ROW}${TAIL_ROW}`
const COLS = TRUNCATED_ROW.length

const openUrl = vi.fn()
const createBrowserTab = vi.fn()

function route(host: string, destination: NormalizedLinkRoute['destination']): NormalizedLinkRoute {
  return { pattern: { kind: 'exact', host }, destination, pluginKey: 'demo', index: 0 }
}

function makeBufferLine(fragment: string): IBufferLine {
  const text = fragment.padEnd(COLS)
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

function click(): void {
  const terminal = makeTerminal()
  handleTerminalWebLinkClick(TRUNCATED_ROW, clickFirstRow(), {
    terminal,
    worktreeId: 'wt-1',
    worktreePath: '/tmp',
    startupCwd: '/tmp',
    getActionDestinations: (url) =>
      httpLinkActionDestinationsFor({ openLinksInApp: false }, { kind: 'local' }, false, url)
  })
}

describe('plugin link routes on hard-wrapped terminal URLs', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('window', { api: { shell: { openUrl } } })
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: false },
      setActiveWorktree: vi.fn(),
      createBrowserTab
    }))
    openUrl.mockReset()
    createBrowserTab.mockReset()
    usePluginLinkRouteStore.setState({ routes: [], loaded: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    usePluginLinkRouteStore.setState({ routes: [], loaded: true })
  })

  it('ignores a route matching only the host the physical row is truncated to', () => {
    usePluginLinkRouteStore.setState({ routes: [route('good.example.com', 'orca-browser')] })

    click()

    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(openUrl).toHaveBeenCalledWith(FULL_URL)
  })

  it('routes on the reconstructed host of the complete URL', () => {
    usePluginLinkRouteStore.setState({
      routes: [route('good.example.com.evil.test', 'orca-browser')]
    })

    click()

    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', FULL_URL, { activate: true })
    expect(openUrl).not.toHaveBeenCalled()
  })

  // Cold-click window: the route table is fetched async, so the first clicks see []. Must degrade
  // to today's behavior — never block the click on an await.
  it('falls back to the settings default while the route table is still empty', () => {
    click()

    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(openUrl).toHaveBeenCalledWith(FULL_URL)
  })
})
