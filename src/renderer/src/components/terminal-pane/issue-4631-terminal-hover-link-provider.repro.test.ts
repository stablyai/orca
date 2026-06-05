import { performance } from 'node:perf_hooks'
import { Terminal } from '@xterm/headless'
import type { IDisposable } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { extractTerminalFileLinks } from '@/lib/terminal-links'
import { createFilePathLinkProvider, getTerminalFileOpenHint } from './terminal-link-handlers'
import { buildWrappedLogicalLine } from './wrapped-terminal-link-ranges'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: undefined,
      setActiveWorktree: vi.fn(),
      createBrowserTab: vi.fn(),
      openFile: vi.fn(),
      setPendingEditorReveal: vi.fn()
    })
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: () => 'plaintext'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

async function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve))
}

function configuredRowCount(): number {
  const raw = process.env.ORCA_4631_WRAP_ROWS
  if (!raw) {
    return 50_000
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50_000
}

function logStage(stage: string, details: Record<string, unknown>): void {
  if (process.env.ORCA_LOG_4631_REPRO !== '1') {
    return
  }
  process.stderr.write(`${JSON.stringify({ issue: 4631, stage, ...details })}\n`)
}

describe('issue 4631 terminal hover link-provider repro', () => {
  it('keeps hover link detection bounded for a huge soft-wrapped terminal line', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('window', {
      api: {
        shell: {
          pathExists: vi.fn().mockResolvedValue(false)
        }
      }
    })

    const rowCount = configuredRowCount()
    const terminal = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      scrollback: rowCount + 100
    })
    const payload = `${'a'.repeat(79)}\r\n${'b'.repeat(80 * rowCount)}`
    const writeStart = performance.now()
    await writeTerminal(terminal, payload)
    logStage('terminal.write', {
      rowCount,
      elapsedMs: Math.round(performance.now() - writeStart),
      bufferBaseY: terminal.buffer.active.baseY
    })

    const targetBufferLine = 2
    const buildStart = performance.now()
    const logicalLine = buildWrappedLogicalLine(terminal.buffer.active, targetBufferLine)
    const buildElapsedMs = performance.now() - buildStart
    logStage('buildWrappedLogicalLine', {
      rowCount,
      elapsedMs: Math.round(buildElapsedMs),
      logicalTextLength: logicalLine?.text.length ?? null,
      wrappedRows: logicalLine?.rows.length ?? null
    })

    const extractStart = performance.now()
    const directLinks = logicalLine ? extractTerminalFileLinks(logicalLine.text) : []
    const extractElapsedMs = performance.now() - extractStart
    logStage('extractTerminalFileLinks', {
      rowCount,
      elapsedMs: Math.round(extractElapsedMs),
      directLinkCount: directLinks.length
    })

    const pane = { id: 1, terminal }
    const managerRef = {
      current: { getPanes: () => [pane] } as unknown as PaneManager
    }
    const provider = createFilePathLinkProvider(
      1,
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        startupCwd: '/repo',
        managerRef,
        linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
        pathExistsCache: new Map()
      },
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      getTerminalFileOpenHint()
    )

    const start = performance.now()
    await new Promise<void>((resolve) => {
      provider.provideLinks(targetBufferLine, () => resolve())
    })
    const elapsedMs = performance.now() - start

    logStage('createFilePathLinkProvider.provideLinks', {
      cols: terminal.cols,
      rowCount,
      elapsedMs: Math.round(elapsedMs),
      bufferBaseY: terminal.buffer.active.baseY,
      targetBufferLine
    })

    expect(buildElapsedMs + extractElapsedMs + elapsedMs).toBeLessThan(100)
  }, 120_000)
})
