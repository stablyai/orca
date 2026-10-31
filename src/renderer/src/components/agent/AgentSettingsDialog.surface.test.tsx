// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { useAppStore } from '@/store'
import type * as StoreModule from '@/store'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '../ui/tooltip'
import AgentSettingsDialog from './AgentSettingsDialog'

// Static rendering must read the installed fixture, rather than Zustand's startup server snapshot.
vi.mock('@/store', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>()
  return {
    ...actual,
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T): T => selector(actual.useAppStore.getState()),
      actual.useAppStore
    )
  }
})

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude'],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

afterEach(() => vi.unstubAllGlobals())

it('keeps the quick dialog per-agent controls without the full-Settings default tiles', () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform: { get: () => ({ platform: 'darwin' }) } }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: 'terminal',
      nativeChatProviders: { claude: false }
    })
  })
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <AgentSettingsDialog open onOpenChange={vi.fn()} />
    </TooltipProvider>
  )
  expect(markup).not.toContain('Open agents as')
  expect(markup).not.toContain('agents-default-surface')
  expect(markup).toContain('Claude')
  expect(markup).toContain('Installed')
  expect(markup).toContain('Chat')
  expect(markup).toContain('CLI')
})
