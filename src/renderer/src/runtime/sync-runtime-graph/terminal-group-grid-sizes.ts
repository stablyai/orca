import {
  terminalGridSizeForBox,
  type TerminalFitMetrics
} from '@/lib/pane-manager/terminal-grid-size-for-box'
import { readTerminalStableCellSize } from '@/lib/pane-manager/terminal-stable-cell-fit-addon'
import { mountedTerminalTabEntries } from '../mounted-terminal-tab-registry'

type GridSize = { cols: number; rows: number }

/** Metrics a new tab's pane will have, read from a mounted pane shaped like one: default font size
 *  (a zoomed pane has its own cells) and no title or banner (either pushes its xterm host down). */
function readDefaultPaneFit(
  defaultFontSize: number
): { metrics: TerminalFitMetrics; inset: { width: number; height: number } } | null {
  for (const [, registered] of mountedTerminalTabEntries()) {
    for (const { terminal, container } of registered.getManager()?.getPanes() ?? []) {
      const cell = readTerminalStableCellSize(terminal)
      if (
        terminal.options.fontSize !== defaultFontSize ||
        container.hasAttribute('data-has-title') ||
        container.querySelector(':scope > .pane-top-banner') ||
        !terminal.element ||
        !cell ||
        cell.width <= 0 ||
        cell.height <= 0
      ) {
        continue
      }
      const hostRect = terminal.element.parentElement?.getBoundingClientRect()
      if (!hostRect || hostRect.width <= 0 || hostRect.height <= 0) {
        continue
      }
      const paneRect = container.getBoundingClientRect()
      const style = getComputedStyle(terminal.element)
      return {
        metrics: {
          cell: { width: cell.width, height: cell.height },
          padding: {
            top: Number.parseInt(style.paddingTop, 10) || 0,
            right: Number.parseInt(style.paddingRight, 10) || 0,
            bottom: Number.parseInt(style.paddingBottom, 10) || 0,
            left: Number.parseInt(style.paddingLeft, 10) || 0
          },
          scrollback: terminal.options.scrollback,
          scrollbar: terminal.options.scrollbar
        },
        inset: { width: paneRect.width - hostRect.width, height: paneRect.height - hostRect.height }
      }
    }
  }
  return null
}

// Content area minus a lone group's body (its tab row and border), last seen on a single-group workspace.
let singleGroupBodyInset: { width: number; height: number } | null = null

export type TerminalGroupGridSizes = {
  groups: Record<string, GridSize>
  /** What a workspace with one group gets: every workspace shares the same content area. */
  singleGroupWorkspace?: GridSize
}

/** The grid an unsplit terminal would get in each shown tab group, and in a single-group workspace
 *  that is not shown; undefined until a pane at the default font is measurable. */
export function measureTerminalGroupGridSizes(
  defaultFontSize: number
): TerminalGroupGridSizes | undefined {
  const fit = readDefaultPaneFit(defaultFontSize)
  if (!fit) {
    return undefined
  }
  const gridFor = (rect: { width: number; height: number }): GridSize =>
    terminalGridSizeForBox(
      { width: rect.width - fit.inset.width, height: rect.height - fit.inset.height },
      fit.metrics
    )
  const groups: Record<string, GridSize> = {}
  const shownBodies: { body: HTMLElement; rect: DOMRect }[] = []
  for (const body of document.querySelectorAll<HTMLElement>('[data-tab-group-body-id]')) {
    const groupId = body.dataset.tabGroupBodyId
    const rect = body.getBoundingClientRect()
    if (groupId && rect.width > 0 && rect.height > 0) {
      groups[groupId] = gridFor(rect)
      shownBodies.push({ body, rect })
    }
  }
  const contentElement = document.querySelector('[data-terminal-workbench-container]')
  const content = contentElement?.getBoundingClientRect()
  if (!contentElement || !content || content.width <= 0 || content.height <= 0) {
    return { groups }
  }
  // The floating terminal panel's body lies outside the content area and is never the lone group.
  const contentBodies = shownBodies.filter(({ body }) => contentElement.contains(body))
  if (contentBodies.length === 1) {
    const body = contentBodies[0].rect
    singleGroupBodyInset = {
      width: content.width - body.width,
      height: content.height - body.height
    }
  }
  return singleGroupBodyInset
    ? {
        groups,
        singleGroupWorkspace: gridFor({
          width: content.width - singleGroupBodyInset.width,
          height: content.height - singleGroupBodyInset.height
        })
      }
    : { groups }
}
