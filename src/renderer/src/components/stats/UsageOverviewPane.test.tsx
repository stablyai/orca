// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
import { UsageOverviewPane } from './UsageOverviewPane'

vi.mock('../../store', async () => {
  const { createTestStore } = await import('../../store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const scanState = {
  enabled: true,
  isScanning: false,
  lastScanStartedAt: 100,
  lastScanCompletedAt: 200,
  lastScanError: null,
  hasAnyClaudeData: true,
  hasAnyCodexData: true,
  hasAnyOpenCodeData: true,
  hasAnyMuseData: true
}

const summary = {
  scope: 'orca',
  range: '30d',
  sessions: 1,
  turns: 1,
  events: 1,
  zeroCacheReadTurns: 0,
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheReuseRate: 0,
  reasoningOutputTokens: 0,
  totalTokens: 150,
  estimatedCostUsd: 1,
  hasUnpricedModels: false,
  topModel: 'test-model',
  topProject: 'test-project',
  hasAnyClaudeData: true,
  hasAnyCodexData: true,
  hasAnyOpenCodeData: true,
  hasAnyMuseData: true
} as const

function createUsageApi() {
  let state = { ...scanState }
  return {
    getScanState: vi.fn(async () => state),
    setEnabled: vi.fn(async ({ enabled }: { enabled: boolean }) => {
      state = { ...state, enabled }
      return state
    }),
    getSnapshot: vi.fn(async () => ({
      scanState: state,
      summary,
      daily: [],
      modelBreakdown: [],
      projectBreakdown: [],
      recentSessions: []
    })),
    refresh: vi.fn(async () => state)
  }
}

let apis: ReturnType<typeof createApis>

function createApis() {
  return {
    claudeUsage: createUsageApi(),
    codexUsage: createUsageApi(),
    openCodeUsage: createUsageApi(),
    museUsage: createUsageApi()
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  apis = createApis()
  vi.stubGlobal('api', apis)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderOverview() {
  render(
    <TooltipProvider>
      <UsageOverviewPane />
    </TooltipProvider>
  )
  await waitFor(() => expect(screen.getByText('600')).toBeInTheDocument())
}

function providerSwitch(label: string) {
  return screen.getByRole('switch', { name: `Enable ${label} usage analytics` })
}

function providerCard(label: string) {
  const card = screen.getByRole('heading', { name: label }).closest('.rounded-lg')
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Missing ${label} provider card`)
  }
  return within(card)
}

describe('UsageOverviewPane provider tracking switches', () => {
  it.each([
    { label: 'Claude', api: 'claudeUsage' },
    { label: 'Codex', api: 'codexUsage' },
    { label: 'OpenCode', api: 'openCodeUsage' },
    { label: 'Muse', api: 'museUsage' }
  ] as const)(
    'disables and re-enables $label without affecting other providers',
    async ({ label, api }) => {
      const user = userEvent.setup()
      await renderOverview()

      expect(providerSwitch(label)).toBeChecked()
      await user.click(providerSwitch(label))

      await waitFor(() => expect(providerSwitch(label)).not.toBeChecked())
      expect(providerCard(label).getByText('Off')).toBeInTheDocument()
      expect(providerCard(label).getByText('0 tokens')).toBeInTheDocument()
      expect(screen.getByText('450')).toBeInTheDocument()
      expect(screen.getAllByRole('switch', { checked: true })).toHaveLength(3)
      expect(apis[api].setEnabled).toHaveBeenCalledWith({ enabled: false })
      for (const [key, otherApi] of Object.entries(apis)) {
        if (key !== api) {
          expect(otherApi.setEnabled).not.toHaveBeenCalled()
        }
        otherApi.refresh.mockClear()
      }

      await user.click(screen.getByRole('button', { name: 'Refresh usage overview' }))
      await waitFor(() => {
        for (const [key, otherApi] of Object.entries(apis)) {
          expect(otherApi.refresh).toHaveBeenCalledTimes(key === api ? 0 : 1)
        }
      })

      await user.click(providerSwitch(label))

      await waitFor(() => expect(providerCard(label).getByText('150 tokens')).toBeInTheDocument())
      expect(providerSwitch(label)).toBeChecked()
      expect(providerCard(label).getByText('Enabled')).toBeInTheDocument()
      expect(screen.getByText('600')).toBeInTheDocument()
      expect(screen.getAllByRole('switch', { checked: true })).toHaveLength(4)
      expect(apis[api].setEnabled).toHaveBeenLastCalledWith({ enabled: true })
    }
  )

  it('keeps card switches available after every provider is disabled', async () => {
    const user = userEvent.setup()
    await renderOverview()

    for (const label of ['Claude', 'Codex', 'OpenCode', 'Muse']) {
      await user.click(providerSwitch(label))
      await waitFor(() => expect(providerSwitch(label)).not.toBeChecked())
    }

    expect(screen.getAllByRole('switch', { checked: false })).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'Refresh usage overview' })).toBeDisabled()
    await user.click(providerSwitch('Codex'))

    await waitFor(() => expect(providerCard('Codex').getByText('150 tokens')).toBeInTheDocument())
    expect(screen.getAllByRole('switch', { checked: true })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Refresh usage overview' })).toBeEnabled()
  })

  it('reflects the acknowledged setting after a delayed update', async () => {
    const user = userEvent.setup()
    await renderOverview()
    const pending = Promise.withResolvers<typeof scanState>()
    apis.codexUsage.setEnabled.mockReturnValueOnce(pending.promise)

    await user.click(providerSwitch('Codex'))
    expect(providerSwitch('Codex')).toBeChecked()
    expect(screen.getByText('600')).toBeInTheDocument()

    await act(async () => pending.resolve({ ...scanState, enabled: false }))

    expect(providerSwitch('Codex')).not.toBeChecked()
    expect(providerCard('Codex').getByText('Off')).toBeInTheDocument()
    expect(screen.getByText('450')).toBeInTheDocument()
  })
})
