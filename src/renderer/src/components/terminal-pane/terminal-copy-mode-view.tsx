import { createRoot } from 'react-dom/client'
import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { translate } from '@/i18n/i18n'
import type { AppMenuSelectionAction } from '@/lib/app-menu-selection-actions'
import type { TerminalCopyModeConfig } from '../../../../shared/terminal-copy-mode-config'
import { createCopyModeKeybindings } from './terminal-copy-mode-keybindings'
import { copyTerminalSelection } from './terminal-selection-copy'
import { createTerminalCopyModeSnapshot } from './terminal-copy-mode-snapshot'
import {
  createCopyModeSelection,
  moveCopyModeCursor,
  renderCopyModeSelection,
  type CopyModeSelection
} from './terminal-copy-mode-selection'
import { TerminalCopyModeStatus } from './TerminalCopyModeStatus'
import { resizeCopyModeSelection } from './terminal-copy-mode-resize'

export function createTerminalCopyModeView(
  pane: ManagedPane,
  config: TerminalCopyModeConfig,
  platform: NodeJS.Platform,
  onExit: () => void,
  canFocus: () => boolean,
  useWebgl: boolean
) {
  const snapshot = createTerminalCopyModeSnapshot(pane, useWebgl, onExit)
  const { terminal, root, cursor, screen, viewport } = snapshot
  const keybindings = createCopyModeKeybindings(config, platform)
  root.addEventListener('focusout', keybindings.reset)
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', translate('terminal.copyMode.active', 'Copy mode'))
  const status = createRoot(snapshot.status)
  let state: CopyModeSelection | null = null
  let disposed = false
  let copying = false
  let fitting = false
  const renderStatus = (): void => {
    status.render(
      <TerminalCopyModeStatus
        config={config}
        platform={platform}
        selecting={state?.anchor != null}
      />
    )
  }
  const renderCursor = (reveal = false): void => {
    if (!state || !screen) {
      return
    }
    const { row, column } = state.cursor
    const visibleRow = row - terminal.buffer.active.viewportY
    cursor.hidden = visibleRow < 0 || visibleRow >= terminal.rows
    const width = Math.max(1, terminal.buffer.active.getLine(row)?.getCell(column)?.getWidth() ?? 1)
    const cell = terminal.dimensions?.css.cell
    const cellWidth = cell?.width || screen.clientWidth / terminal.cols
    const cellHeight = cell?.height || screen.clientHeight / terminal.rows
    cursor.style.left = `${column * cellWidth}px`
    cursor.style.top = `${visibleRow * cellHeight}px`
    cursor.style.width = `${cellWidth * width}px`
    cursor.style.height = `${cellHeight}px`
    if (reveal && !cursor.hidden) {
      const rect = cursor.getBoundingClientRect()
      const bounds = viewport.getBoundingClientRect()
      const right = bounds.left + viewport.clientWidth
      const bottom = bounds.top + viewport.clientHeight
      if (rect.left < bounds.left) {
        viewport.scrollLeft -= bounds.left - rect.left
      } else if (rect.right > right) {
        viewport.scrollLeft += rect.right - right
      }
      if (rect.top < bounds.top) {
        viewport.scrollTop -= bounds.top - rect.top
      } else if (rect.bottom > bottom) {
        viewport.scrollTop += rect.bottom - bottom
      }
    }
  }
  const render = (): void => {
    if (!state) {
      return
    }
    const row = state.cursor.row
    if (row < terminal.buffer.active.viewportY) {
      terminal.scrollToLine(row)
    } else if (row >= terminal.buffer.active.viewportY + terminal.rows) {
      terminal.scrollToLine(row - terminal.rows + 1)
    }
    renderCopyModeSelection(terminal, state)
    renderCursor(true)
  }
  const copy = async (): Promise<void> => {
    if (!state || copying || disposed) {
      return
    }
    copying = true
    try {
      const copied = await copyTerminalSelection({
        terminal,
        writeClipboardText: window.api.ui.writeTerminalClipboardText
      })
      if (!disposed && copied && config.exitOnCopy) {
        onExit()
      }
    } catch {
      if (!disposed) {
        toast.error(
          translate('terminal.copyMode.copyFailed', 'Could not copy terminal selection. Try again.')
        )
      }
    } finally {
      copying = false
    }
  }
  renderStatus()
  const scroll = terminal.onScroll(() => renderCursor())
  const fitSnapshot = (): void => {
    if (!state || disposed || fitting) {
      return
    }
    snapshot.repairRenderer()
    const dimensions = snapshot.fitAddon.proposeDimensions()
    if (!dimensions || (dimensions.cols === terminal.cols && dimensions.rows === terminal.rows)) {
      renderCursor(true)
      return
    }
    fitting = true
    // xterm discards rows below its cursor when reducing height; park the hidden cursor last.
    terminal.write(`\x1b[${terminal.rows};1H`, () => {
      fitting = false
      if (!state || disposed) {
        return
      }
      snapshot.repairRenderer()
      const latest = snapshot.fitAddon.proposeDimensions()
      if (latest && resizeCopyModeSelection(terminal, state, latest)) {
        render()
      }
    })
  }
  const resize = new ResizeObserver(fitSnapshot)
  resize.observe(viewport)
  if (screen) {
    resize.observe(screen)
  }
  void snapshot.ready.then(() => {
    if (disposed) {
      return
    }
    state = createCopyModeSelection(terminal, snapshot.position)
    fitSnapshot()
    render()
    if (canFocus()) {
      terminal.focus()
    }
  })
  return {
    contains: (target: EventTarget | null) => target instanceof Node && root.contains(target),
    focus: () => terminal.focus(),
    handleMenuSelectionAction(action: AppMenuSelectionAction): void {
      if (!state || disposed) {
        return
      }
      if (action === 'copy') {
        void copy()
        return
      }
      state.anchor = { row: 0, column: 0 }
      state.cursor = state.buffer.characterStart(state.buffer.lastRow, terminal.cols - 1)
      state.preferredColumn = state.buffer.logicalColumn(state.cursor)
      renderStatus()
      render()
    },
    handleKeyDown(event: KeyboardEvent): boolean {
      const action = keybindings.handle(event)
      if (!action) {
        return false
      }
      if (action === 'pending') {
        return true
      }
      if (action === 'exit') {
        if (!event.repeat) {
          onExit()
        }
      } else if (state && !event.isComposing) {
        if (action === 'toggleSelection') {
          if (!event.repeat) {
            state.anchor = state.anchor ? null : { ...state.cursor }
            renderStatus()
          }
        } else if (action === 'copy') {
          if (!event.repeat && state.anchor) {
            void copy()
          }
        } else {
          moveCopyModeCursor(terminal, state, action)
        }
        render()
      }
      return true
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      resize.disconnect()
      scroll.dispose()
      root.removeEventListener('focusout', keybindings.reset)
      keybindings.reset()
      status.unmount()
      snapshot.dispose()
      state = null
    }
  }
}

export type TerminalCopyModeView = ReturnType<typeof createTerminalCopyModeView>
