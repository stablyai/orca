import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_MODE_RESET,
  RESET_GRAPHIC_RENDITION,
  RELEASE_SYNCHRONIZED_OUTPUT
} from '../../../../shared/terminal-mode-reset-profiles'
import { Terminal } from '@xterm/headless'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { buildFreshShellViewportBlankingSequence } from './terminal-restored-viewport'
import {
  flushAsyncTicks,
  writeHeadlessTerminal,
  renderHeadlessTerminalState
} from './pty-connection-test-async'
import { NORMAL_BUFFER_PROLOGUE } from './pty-connection-test-constants'
import {
  terminalWriteText,
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionColdRestoreRepaintTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })
    it('paints only the daemon snapshot when reattach result includes both snapshot and replay', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: sessionId,
            snapshot: 'snapshot-payload',
            replay: 'replay-payload'
          }
        }
        return null
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
        }
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_GRAPHIC_RENDITION}snapshot-payload`,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith('replay-payload', expect.any(Function))
    })

    it('paints only relay replay when reattach result has replay and coldRestore but no snapshot', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: sessionId,
            replay: 'replay-payload',
            coldRestore: { scrollback: 'cold-payload' }
          }
        }
        return null
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
        }
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_GRAPHIC_RENDITION}replay-payload`,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith('cold-payload', expect.any(Function))
      // Why: the replay branch supersedes cold-restore but must still ack, or the daemon redelivers the cold-restore payload next reattach.
      // A layout-owner window names the pane it painted, so main releases only its current terminal.
      expect(window.api.pty.ackColdRestore).toHaveBeenCalledWith(
        'tab-pty',
        ...(ORCA_LAYOUT_OWNER_IS_MAIN
          ? [{ worktreeId: deps.worktreeId, tabId: deps.tabId, leafId: LEAF_1 }]
          : [])
      )
    })

    it('blanks restored scrollback before fresh shell output', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('fresh-pty')
      const written: string[] = []
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          callbacks.onData?.('PS >')
          return 'fresh-pty'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_1 },
            activeLeafId: LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        }
      } as StoreState

      const pane = createPane(1)
      pane.terminal.rows = 4
      pane.terminal.cols = 20
      pane.terminal.write = vi.fn((data: string | Uint8Array, callback?: () => void) => {
        data = terminalWriteText(data)
        written.push(data)
        callback?.()
      })
      const manager = createManager(1)
      const deps = createDeps({
        restoredViewportBlankingPanesRef: { current: new Set([1]) }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      const blankViewport = buildFreshShellViewportBlankingSequence(4)
      expect(written).toContain(blankViewport)
      expect(written.indexOf(blankViewport)).toBeLessThan(written.indexOf('PS >'))

      const rendered = await renderHeadlessTerminalState(
        ['old TUI row with a long tail\r\nold TUI row two', blankViewport, 'PS >'],
        20,
        4
      )
      expect(rendered.baseY).toBeGreaterThan(0)
      expect(rendered.allLines.some((line) => line.includes('old TUI row'))).toBe(true)
      expect(rendered.visibleLines).toEqual(['PS >', '', '', ''])
    })

    it('cold-restores at the recovered grid and clears only the dirty viewport before blanking', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('fresh-pty')
      const written: string[] = []
      const operations: (
        | { kind: 'write'; data: string }
        | { kind: 'resize'; cols: number; rows: number }
      )[] = []
      const destinationCols = 10
      const destinationRows = 5
      const recoveredCols = 20
      const recoveredRows = 3
      const coldScrollback = '\x1b[1;1HCOLD\x1b[1;15HEND\r\nCOLD_SOURCE_ROW_02'
      const groundedColdScrollback = `${RESET_GRAPHIC_RENDITION}${coldScrollback}`
      const viewportClear = `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[H`
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: 'fresh-pty',
            coldRestore: {
              scrollback: coldScrollback,
              cwd: '/tmp/wt-1',
              cols: recoveredCols,
              rows: recoveredRows
            }
          }
        }
        return 'fresh-pty'
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
        }
      } as StoreState

      const pane = createPane(1)
      pane.terminal.rows = destinationRows
      pane.terminal.cols = destinationCols
      let sawViewportClear = false
      const preResizeBarrier = { release: null as (() => void) | null }
      pane.terminal.write = vi.fn((data: string | Uint8Array, callback?: () => void) => {
        data = terminalWriteText(data)
        written.push(data)
        operations.push({ kind: 'write', data })
        if (data === viewportClear) {
          sawViewportClear = true
        } else if (sawViewportClear && data.length === 0 && preResizeBarrier.release === null) {
          preResizeBarrier.release = callback ?? (() => {})
          return
        }
        callback?.()
      })
      pane.terminal.resize = vi.fn((cols: number, rows: number) => {
        operations.push({ kind: 'resize', cols, rows })
        pane.terminal.cols = cols
        pane.terminal.rows = rows
      })
      const manager = createManager(1)
      pane.fitAddon.proposeDimensions = vi.fn(() => ({
        cols: destinationCols,
        rows: destinationRows
      }))
      pane.fitAddon.fit = vi.fn(() => {
        pane.terminal.resize(destinationCols, destinationRows)
      })
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      expect(preResizeBarrier.release).not.toBeNull()
      expect(pane.terminal.resize).not.toHaveBeenCalledWith(recoveredCols, recoveredRows)
      expect(written).not.toContain(coldScrollback)

      preResizeBarrier.release?.()
      await flushAsyncTicks(20)

      const blankViewport = buildFreshShellViewportBlankingSequence(destinationRows)
      expect(pane.terminal.resize).toHaveBeenCalledWith(recoveredCols, recoveredRows)
      expect(transport.resize).not.toHaveBeenCalledWith(recoveredCols, recoveredRows)
      expect(transport.resize).toHaveBeenCalledWith(destinationCols, destinationRows)
      expect(transport.resize).toHaveBeenLastCalledWith(destinationCols, destinationRows, {
        claim: true
      })
      expect(written).toContain(viewportClear)
      expect(written).not.toContain(NORMAL_BUFFER_PROLOGUE)
      expect(written).toEqual(
        expect.arrayContaining([groundedColdScrollback, POST_REPLAY_MODE_RESET, blankViewport])
      )
      expect(written.indexOf(viewportClear)).toBeLessThan(written.indexOf(groundedColdScrollback))
      expect(written.indexOf(groundedColdScrollback)).toBeLessThan(written.indexOf(blankViewport))
      const viewportClearOperation = operations.findIndex(
        (operation) => operation.kind === 'write' && operation.data === viewportClear
      )
      const recoveredResizeOperation = operations.findIndex(
        (operation) =>
          operation.kind === 'resize' &&
          operation.cols === recoveredCols &&
          operation.rows === recoveredRows
      )
      expect(viewportClearOperation).toBeLessThan(recoveredResizeOperation)

      // Model the real op order: the old path appended a 20-col snapshot onto a dirty 10-col xterm, wrapping rows at the wrong grid.
      const rendered = new Terminal({
        cols: destinationCols,
        rows: destinationRows,
        allowProposedApi: true
      })
      try {
        await writeHeadlessTerminal(
          rendered,
          'KEEP_1\r\nKEEP_2\r\nOLD_ROW_1\r\nOLD_ROW_2\r\nOLD_ROW_3\r\nOLD_ROW_4\r\nOLD_ROW_5'
        )
        await writeHeadlessTerminal(rendered, '\x1b[44m')
        let replayedAtRecoveredGrid = false
        let sourceGridLines: string[] = []
        for (const operation of operations) {
          if (operation.kind === 'resize') {
            if (
              replayedAtRecoveredGrid &&
              operation.cols === destinationCols &&
              operation.rows === destinationRows &&
              sourceGridLines.length === 0
            ) {
              sourceGridLines = Array.from(
                { length: rendered.buffer.active.length },
                (_, lineIndex) =>
                  rendered.buffer.active.getLine(lineIndex)?.translateToString(true) ?? ''
              )
            }
            rendered.resize(operation.cols, operation.rows)
            if (operation.cols === recoveredCols && operation.rows === recoveredRows) {
              replayedAtRecoveredGrid = true
            }
          } else {
            await writeHeadlessTerminal(rendered, operation.data)
            if (operation.data === viewportClear) {
              expect(rendered.buffer.active.getLine(0)?.getCell(0)?.getBgColor()).toBe(-1)
            }
          }
        }
        if (sourceGridLines.length === 0) {
          sourceGridLines = Array.from(
            { length: rendered.buffer.active.length },
            (_, lineIndex) =>
              rendered.buffer.active.getLine(lineIndex)?.translateToString(true) ?? ''
          )
        }
        expect(sourceGridLines).toContain('COLD          END')
        if (rendered.cols !== destinationCols || rendered.rows !== destinationRows) {
          rendered.resize(destinationCols, destinationRows)
        }
        await writeHeadlessTerminal(rendered, 'PS >')
        const buffer = rendered.buffer.active
        const lines = Array.from({ length: buffer.length }, (_, lineIndex) =>
          buffer.getLine(lineIndex)?.translateToString(true)
        )
        const logicalLines: string[] = []
        for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
          const line = buffer.getLine(lineIndex)
          const text = line?.translateToString(true) ?? ''
          if (line?.isWrapped && logicalLines.length > 0) {
            logicalLines[logicalLines.length - 1] += text
          } else {
            logicalLines.push(text)
          }
        }
        const visibleLines = Array.from({ length: rendered.rows }, (_, row) =>
          buffer.getLine(buffer.viewportY + row)?.translateToString(true)
        )
        expect(buffer.baseY).toBeGreaterThan(0)
        expect(lines.some((line) => line?.includes('OLD_ROW_'))).toBe(false)
        expect(lines.some((line) => line?.includes('KEEP_1'))).toBe(true)
        expect(lines.some((line) => line?.includes('KEEP_2'))).toBe(true)
        expect(logicalLines.some((line) => /COLD\s+END/.test(line))).toBe(true)
        expect(logicalLines.some((line) => line.includes('COLD_SOURCE_ROW_02'))).toBe(true)
        expect(visibleLines).toEqual(['PS >', '', '', '', ''])
      } finally {
        rendered.dispose()
      }
    })
  })
}
