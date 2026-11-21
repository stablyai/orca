// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentCliUpdateHost } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentCliUpdateStatusSegment } from './AgentCliUpdateStatusSegment'

const store = vi.hoisted((): { state: Record<string, unknown> } => ({ state: {} }))
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(store.state)
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  store.state = {}
})

const localClaudeUpdate = new Map<string, AgentCliUpdateHost>([
  [
    '',
    {
      updates: [
        {
          agent: 'claude',
          installedVersion: '2.1.250',
          latestVersion: '2.1.327',
          command: 'claude update',
          runnable: true
        }
      ],
      runs: {}
    }
  ]
])

function openWith(runtimeEnvironments: { id: string; name: string }[]): void {
  store.state = {
    agentCliUpdates: localClaudeUpdate,
    runtimeEnvironments,
    checkAgentCliUpdates: async () => {}
  }
  render(
    <TooltipProvider>
      <AgentCliUpdateStatusSegment />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByText('1 CLI update'))
}

it('names this computer for a local-only list once a server is paired', () => {
  openWith([{ id: 'server-1', name: 'Build server' }])
  expect(screen.getByText('This computer')).toBeTruthy()
})

it('leaves a paired web window unlabeled, since its local list is the server', () => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  openWith([{ id: 'server-1', name: 'Build server' }])
  expect(screen.getByText('1 CLI update available')).toBeTruthy()
  expect(screen.queryByText('This computer')).toBeNull()
})
