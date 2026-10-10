import { expect, vi } from 'vitest'
import type { IDisposable, ILink } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { createFilePathLinkProvider, getTerminalFileOpenHint } from './terminal-link-handlers'
import type {
  installFilePathLinkClickFallback,
  openFilePathLinkAtBufferPosition
} from './terminal-link-handlers'
import type { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'

export type TestBufferLine = {
  isWrapped: boolean
  length: number
  translateToString: (
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
    outColumns?: number[]
  ) => string
}

export function defaultColumnsForText(text: string): number[] {
  return Array.from({ length: text.length + 1 }, (_value, index) => index)
}

export function makeBufferLine(
  text: string,
  options: { isWrapped?: boolean; columns?: number[] } = {}
): TestBufferLine {
  const columns = options.columns ?? defaultColumnsForText(text)
  return {
    isWrapped: options.isWrapped ?? false,
    length: text.length,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = text.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.length = 0
        for (let index = startColumn; index <= endColumn; index++) {
          outColumns.push(columns[index] ?? index)
        }
      }
      return text.slice(startColumn, endColumn)
    }
  }
}

export function makePane(rows: TestBufferLine[]): { id: number; terminal: unknown } {
  return {
    id: 1,
    terminal: {
      buffer: {
        active: {
          getLine: (y: number) => rows[y]
        }
      }
    }
  }
}

export function createProviderSetup(
  rows: TestBufferLine[],
  pathExistsCache = new Map<string, boolean>([
    ['/repo', true],
    ['/repo/CLAUDE.md', true],
    ['/repo/package.json', true],
    ['/repo/Folder With Space/content.js', true],
    ['/repo/My Folder', true]
  ]),
  depsOverrides: Partial<Parameters<typeof createFilePathLinkProvider>[1]> = {}
) {
  const pane = makePane(rows)
  const managerRef = {
    current: { getPanes: () => [pane] } as unknown as PaneManager
  }
  const linkTooltip = { textContent: '', style: { display: '' } } as unknown as HTMLElement
  const provider = createFilePathLinkProvider(
    1,
    {
      worktreeId: 'wt-1',
      worktreePath: depsOverrides.worktreePath ?? '/repo',
      startupCwd: '/repo',
      managerRef,
      linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
      pathExistsCache,
      ...depsOverrides
    },
    linkTooltip,
    getTerminalFileOpenHint()
  )
  return { provider, linkTooltip }
}

export function createProvider(rows: TestBufferLine[]) {
  return createProviderSetup(rows).provider
}

export function collectLinks(
  rowsOrText: TestBufferLine[] | string,
  bufferLineNumber = 1
): Promise<ILink[]> {
  const rows = typeof rowsOrText === 'string' ? [makeBufferLine(rowsOrText)] : rowsOrText
  const provider = createProvider(rows)
  return new Promise<ILink[]>((resolve) => {
    provider.provideLinks(bufferLineNumber, (links) => resolve(links ?? []))
  })
}

export function containsBufferPoint(link: ILink, x: number, y: number): boolean {
  const { start, end } = link.range
  if (y < start.y || y > end.y) {
    return false
  }
  if (start.y === end.y) {
    return x >= start.x && x <= end.x
  }
  if (y === start.y) {
    return x >= start.x
  }
  if (y === end.y) {
    return x <= end.x
  }
  return true
}

export function makeBuffer(
  rows: TestBufferLine[]
): Parameters<typeof openFilePathLinkAtBufferPosition>[0] {
  return { getLine: (y: number) => rows[y] } as Parameters<
    typeof openFilePathLinkAtBufferPosition
  >[0]
}

export function makeFallbackTerminal(rows: TestBufferLine[]): {
  terminal: Parameters<typeof installFilePathLinkClickFallback>[1] &
    Parameters<typeof installHttpLinkClickFallback>[0]
  element: {
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
    querySelector: ReturnType<typeof vi.fn>
  }
} {
  const screen = {
    classList: { contains: vi.fn(() => true) },
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 800,
      height: 400
    })
  }
  const element = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn(() => screen)
  }
  return {
    terminal: {
      cols: 80,
      rows: 40,
      element,
      buffer: {
        active: {
          viewportY: 0,
          getLine: (y: number) => rows[y]
        }
      },
      clearSelection: vi.fn()
    } as unknown as Parameters<typeof installFilePathLinkClickFallback>[1],
    element
  }
}

export function getRegisteredMouseUpHandler(element: {
  addEventListener: ReturnType<typeof vi.fn>
}): (event: MouseEvent) => void {
  const registration = element.addEventListener.mock.calls.find(
    ([eventName]) => eventName === 'mouseup'
  )
  expect(registration, 'mouseup handler should be registered').toBeDefined()
  expect(registration![2]).toEqual({ capture: true })
  return registration![1] as (event: MouseEvent) => void
}

export function getRegisteredBubbleMouseUpHandler(element: {
  addEventListener: ReturnType<typeof vi.fn>
}): (event: MouseEvent) => void {
  const registration = element.addEventListener.mock.calls.find(
    ([eventName, _handler, options]) => eventName === 'mouseup' && options === undefined
  )
  expect(registration, 'bubble mouseup handler should be registered').toBeDefined()
  return registration![1] as (event: MouseEvent) => void
}
