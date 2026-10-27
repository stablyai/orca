// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { getMountedAgentSessionRestart } from '@/lib/agent-session-restart-mounted'
import { useMountedAgentSessionRestarters } from './use-mounted-agent-session-restarters'

it('registers after the later mount effect initializes a restored pane and rejects stale ownership', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const leafId = '0195f2ce-1111-4000-8000-000000000001'
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Invalid fixture leaf')
  }
  const pane = { id: 1, leafId, container: document.createElement('div') }
  const manager = { getPanes: () => [{ ...pane }] }
  const managerRef: { current: typeof manager | null } = { current: null }
  const restart = vi.fn()
  const controller: Parameters<typeof useMountedAgentSessionRestarters>[0] = {
    managerRef,
    paneTransportsRef: { current: new Map() },
    savedLayout: { ptyIdsByLeafId: { [leafId]: 'restored-pty' } }
  }
  function RestoredPane() {
    useMountedAgentSessionRestarters(controller, restart)
    useEffect(() => {
      managerRef.current = manager
      return () => {
        managerRef.current = null
      }
    }, [])
    return null
  }
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<RestoredPane />)
    })
    const callback = getMountedAgentSessionRestart('restored-pty')
    expect(callback).toBeDefined()
    pane.container.dataset.ptyId = 'restored-pty'
    expect(callback?.({ command: 'claude --resume original' })).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
    pane.container.dataset.ptyId = 'different-pty'
    expect(callback?.({ command: 'claude --resume original' })).toBe(false)
    expect(restart).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  expect(getMountedAgentSessionRestart('restored-pty')).toBeUndefined()
})
