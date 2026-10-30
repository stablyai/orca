// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureTerminalGroupGridSizes } from './terminal-group-grid-sizes'

type FakePane = { terminal: unknown; container: HTMLElement }
const panes = vi.hoisted((): { list: FakePane[] } => ({ list: [] }))
vi.mock('../mounted-terminal-tab-registry', () => ({
  mountedTerminalTabEntries: () => [
    ['tab-1', { getManager: () => ({ getPanes: () => panes.list }) }]
  ]
}))

function withRect<T extends HTMLElement>(element: T, width: number, height: number): T {
  element.getBoundingClientRect = () => new DOMRect(0, 0, width, height)
  return element
}

/** A pane whose xterm host sits 4px inside it, like `.xterm-container`. */
function pane(opts: { fontSize: number; cellWidth: number; title?: boolean }): FakePane {
  const container = withRect(document.createElement('div'), 500, 400)
  if (opts.title) {
    container.setAttribute('data-has-title', '')
  }
  const host = withRect(document.createElement('div'), 496, 396)
  const element = document.createElement('div')
  host.appendChild(element)
  container.appendChild(host)
  return {
    container,
    terminal: {
      element,
      options: { fontSize: opts.fontSize, scrollback: 1000, scrollbar: undefined },
      dimensions: {
        device: { cell: { width: opts.cellWidth, height: 16 } },
        css: { cell: { width: opts.cellWidth, height: 16 } }
      }
    }
  }
}

function groupBody(
  id: string,
  width: number,
  height: number,
  parent: HTMLElement = document.body
): void {
  const body = withRect(document.createElement('div'), width, height)
  body.dataset.tabGroupBodyId = id
  parent.appendChild(body)
}

function contentArea(width: number, height: number): HTMLElement {
  const content = withRect(document.createElement('div'), width, height)
  content.setAttribute('data-terminal-workbench-container', '')
  document.body.appendChild(content)
  return content
}

afterEach(() => {
  panes.list = []
  document.body.replaceChildren()
})

describe('measureTerminalGroupGridSizes', () => {
  it('sizes each group from a pane at the default font with no title', () => {
    panes.list = [
      pane({ fontSize: 20, cellWidth: 12 }),
      pane({ fontSize: 14, cellWidth: 10, title: true }),
      pane({ fontSize: 14, cellWidth: 8 })
    ]
    groupBody('group-a', 548, 1004)
    groupBody('group-b', 1100, 500)

    // (548 - 4 inset - 14 scrollbar) / 8 = 66; (1004 - 4) / 16 = 62.
    expect(measureTerminalGroupGridSizes(14)).toEqual({
      groups: {
        'group-a': { cols: 66, rows: 62 },
        'group-b': { cols: 135, rows: 31 }
      }
    })
  })

  it("sizes a single-group workspace from the content area minus a lone group's tab row", () => {
    panes.list = [pane({ fontSize: 14, cellWidth: 8 })]
    const content = contentArea(1930, 1330)
    groupBody('group-a', 1929, 1294, content)
    // Neither the floating panel's body nor a hidden workspace's body is another group here.
    groupBody('floating', 600, 400)
    groupBody('hidden', 0, 0, content)
    // Remember lone-group inset for later split-workspace estimates of single-group capacity.
    expect(measureTerminalGroupGridSizes(14)?.singleGroupWorkspace).toEqual({ cols: 238, rows: 80 })

    document.body.replaceChildren()
    const splitContent = contentArea(1600, 1330)
    groupBody('group-a', 799, 1294, splitContent)
    groupBody('group-b', 800, 1294, splitContent)
    // (1600 - 1 - 4 inset - 14 scrollbar) / 8 = 197; (1330 - 36 - 4) / 16 = 80.
    expect(measureTerminalGroupGridSizes(14)?.singleGroupWorkspace).toEqual({ cols: 197, rows: 80 })
  })

  it('leaves the sizes out when no pane at the default font is measurable', () => {
    panes.list = [pane({ fontSize: 20, cellWidth: 12 })]
    groupBody('group-a', 548, 1004)

    expect(measureTerminalGroupGridSizes(14)).toBeUndefined()
  })
})
