/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const returnToMain = vi.fn()
const previewProps = vi.hoisted(() => ({ ptyId: '', className: '' }))

vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId, className }: { ptyId: string; className?: string }) => {
    previewProps.ptyId = ptyId
    previewProps.className = className ?? ''
    return <div data-testid="terminal-preview" className={className} />
  }
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

  it('attaches the preview by PTY id and can return the tab', () => {
    vi.stubGlobal('window', { api: { detachedTerminal: { returnToMain } } })
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => root.render(<DetachedTerminalWindow tabId="tab-1" ptyId="pty-1" title="Shell" />))
    act(() => container.querySelector('button')?.click())

    expect(previewProps.ptyId).toBe('pty-1')
    expect(previewProps.className).toContain('h-full')
    expect(returnToMain).toHaveBeenCalledWith('tab-1')
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })
})
