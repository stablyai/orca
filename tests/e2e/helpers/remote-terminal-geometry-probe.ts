import type { Page } from '@stablyai/playwright-test'

/** Records the actual mutation and its renderer metrics without changing terminal input. */
export async function installRemoteTerminalGeometryProbe(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const pane = window.__paneManagers?.get(id)?.getActivePane?.()
    if (!pane) {
      throw new Error('No pane for geometry probe')
    }
    const events: unknown[] = []
    Reflect.set(window, '__remoteTerminalGeometryEvents', events)
    const measure = () => {
      const parent = pane.terminal.element?.parentElement
      const core = Reflect.get(pane.terminal, '_core')
      const style = parent ? getComputedStyle(parent) : null
      return {
        grid: { cols: pane.terminal.cols, rows: pane.terminal.rows },
        parent: { width: style?.width, height: style?.height, display: style?.display },
        cell: core?._renderService?.dimensions?.css?.cell,
        ptyId: pane.container.dataset.ptyId,
        time: performance.now()
      }
    }
    const resize = pane.terminal.resize.bind(pane.terminal)
    pane.terminal.resize = (cols, rows) => {
      events.push({
        kind: 'resize',
        cols,
        rows,
        ...measure(),
        stack: new Error('terminal resize').stack
      })
      resize(cols, rows)
    }
    const propose = pane.fitAddon.proposeDimensions.bind(pane.fitAddon)
    pane.fitAddon.proposeDimensions = () => {
      const proposal = propose()
      events.push({
        kind: 'proposal',
        proposal,
        ...measure(),
        stack: new Error('fit proposal').stack
      })
      return proposal
    }
  }, tabId)
}

export async function readRemoteTerminalGeometryProbe(page: Page): Promise<unknown> {
  return page.evaluate(() => Reflect.get(window, '__remoteTerminalGeometryEvents'))
}
