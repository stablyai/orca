// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SeveredTerminalDaemonBanner } from './SeveredTerminalDaemonBanner'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const DAEMON = { pid: 4288, linuxStartTicks: '777', bootId: 'boot-1', liveSessionCount: 3 }
const roots: Root[] = []
let severedDaemon: ReturnType<typeof vi.fn>
let restartSeveredDaemon: ReturnType<typeof vi.fn>

function installApi(platform: string, severed: typeof DAEMON | null): void {
  severedDaemon = vi.fn(async () => ({ severed }))
  restartSeveredDaemon = vi.fn(async () => ({ status: 'restarted', killedCount: 3 }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      platform: { get: () => ({ platform }) },
      pty: { management: { severedDaemon, restartSeveredDaemon } }
    }
  })
}

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<SeveredTerminalDaemonBanner />)
  })
  return container
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!match) {
    throw new Error(`no button ${label}`)
  }
  return match
}

describe('SeveredTerminalDaemonBanner', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()))
    document.body.innerHTML = ''
  })

  it('confirms that a restart ends processes, then restarts the incarnation it showed', async () => {
    installApi('linux', DAEMON)
    await render()

    await act(async () => button('Restart terminal daemon').click())
    const dialog = document.body.textContent ?? ''
    expect(dialog).toContain('Restarting ends every process')
    expect(dialog).toContain('Agents that support resume can be resumed')
    expect(dialog).toContain('shells and other jobs cannot')
    expect(restartSeveredDaemon).not.toHaveBeenCalled()

    await act(async () => button('Restart and end processes').click())
    expect(restartSeveredDaemon).toHaveBeenCalledWith({
      pid: 4288,
      linuxStartTicks: '777',
      bootId: 'boot-1'
    })
  })
})
