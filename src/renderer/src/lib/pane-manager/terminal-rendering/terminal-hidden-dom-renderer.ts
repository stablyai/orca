import type { Terminal } from '@xterm/xterm'

type InternalRendererControl = {
  hasRenderer: () => boolean
  setRenderer: (renderer: unknown) => void
  handleResize: ((cols: number, rows: number) => void) | null
  createRenderer: () => unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getInternalRendererControl(terminal: Terminal): InternalRendererControl | null {
  if (!('_core' in terminal) || !isRecord(terminal._core)) {
    return null
  }
  const core = terminal._core
  if (isRecord(core._store) && core._store._isDisposed === true) {
    return null
  }
  const renderService = core._renderService
  const createRenderer = core._createRenderer
  if (!isRecord(renderService) || typeof createRenderer !== 'function') {
    return null
  }
  const hasRenderer = renderService.hasRenderer
  const setRenderer = renderService.setRenderer
  if (typeof hasRenderer !== 'function' || typeof setRenderer !== 'function') {
    return null
  }
  const handleResize = renderService.handleResize
  return {
    hasRenderer: () => Boolean(hasRenderer.call(renderService)),
    setRenderer: (renderer: unknown) => {
      setRenderer.call(renderService, renderer)
    },
    handleResize:
      typeof handleResize === 'function'
        ? (cols: number, rows: number) => {
            handleResize.call(renderService, cols, rows)
          }
        : null,
    createRenderer: () => createRenderer.call(core)
  }
}

/**
 * Drops xterm's DOM renderer (3 <style> tags / 793 CSS rules + DOM rows per pane) while a pane
 * is hidden without WebGL. RenderService caches dimensions and null-guards all renderer calls.
 */
export function detachHiddenDomRenderer(terminal: Terminal): void {
  const control = getInternalRendererControl(terminal)
  if (!control) {
    return
  }
  if (control.hasRenderer()) {
    control.setRenderer(undefined)
  }
}

/** Restores xterm's DOM renderer on reveal when WebGL did not attach. */
export function restoreDomRendererIfMissing(terminal: Terminal): void {
  const control = getInternalRendererControl(terminal)
  if (!control || control.hasRenderer()) {
    return
  }
  control.setRenderer(control.createRenderer())
  control.handleResize?.(terminal.cols, terminal.rows)
}
