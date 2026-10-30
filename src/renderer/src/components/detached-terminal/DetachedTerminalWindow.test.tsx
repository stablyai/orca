/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const returnToMain = vi.fn()
const previewProps = vi.hoisted(() => ({
  ptyId: '',
  className: '',
  scrollbackRows: undefined as number | undefined,
  terminalInput: undefined as unknown
}))

vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({
    ptyId,
    className,
    scrollbackRows,
    terminalInput
  }: {
    ptyId: string
    className?: string
    scrollbackRows?: number
    terminalInput?: unknown
  }) => {
    previewProps.ptyId = ptyId
    previewProps.className = className ?? ''
    previewProps.scrollbackRows = scrollbackRows
    previewProps.terminalInput = terminalInput
    return <div data-testid="terminal-preview" className={className} />
  }
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: { settings: { terminalScrollbackRows: number } }) => unknown) =>
    select({ settings: { terminalScrollbackRows: 10_000 } })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { DetachedTerminalWindow, readDetachedTerminalWindowParams } from './DetachedTerminalWindow'

describe('DetachedTerminalWindow', () => {
  it('reads its immutable tab and PTY identity from the window URL', () => {
    expect(
      readDetachedTerminalWindowParams('?surface=terminal&tabId=tab-1&ptyId=pty-1&title=Shell')
    ).toEqual({ tabId: 'tab-1', ptyId: 'pty-1', title: 'Shell' })
  })

  it('attaches the preview by PTY id and can return the tab', async () => {
    const conptyInput = { hostPlatform: 'win32', localWindowsConpty: true }
    let pushInput: (input: unknown) => void = () => undefined
    const getTerminalInput = vi.fn(async () => conptyInput)
    vi.stubGlobal('window', {
      api: {
        detachedTerminal: {
          returnToMain,
          getTerminalInput,
          onTerminalInput: (callback: (input: unknown) => void) => {
            pushInput = callback
            return () => undefined
          }
        }
      }
    })
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => root.render(<DetachedTerminalWindow tabId="tab-1" ptyId="pty-1" title="Shell" />))
    // Why: xterm takes its ConPTY options at mount, so the preview waits for the pane's input facts.
    expect(container.querySelector('[data-testid="terminal-preview"]')).toBeNull()
    await act(async () => undefined)
    expect(getTerminalInput).toHaveBeenCalledWith('tab-1')
    expect(previewProps.terminalInput).toBe(conptyInput)

    const agentInput = { hostPlatform: 'win32', localWindowsConpty: true, ctrlEnterCsiU: true }
    act(() => pushInput(agentInput))
    expect(previewProps.terminalInput).toBe(agentInput)
    act(() => container.querySelector('button')?.click())

    expect(previewProps.ptyId).toBe('pty-1')
    expect(previewProps.className).toContain('h-full')
    // The companion keeps the pane's scrollback instead of a short preview.
    expect(previewProps.scrollbackRows).toBe(10_000)
    expect(returnToMain).toHaveBeenCalledWith('tab-1')
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })
})
