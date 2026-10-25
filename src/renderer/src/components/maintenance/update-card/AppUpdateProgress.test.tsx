// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppUpdateBatch } from '../../../../../shared/app-update-batch'
import { useAppStore } from '@/store'
import { UpdateCard } from '@/components/UpdateCard'
import { UpdateStatusSegment } from '@/components/status-bar/UpdateStatusSegment'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IncludeRemotes } from './IncludeRemotes'

const batch: AppUpdateBatch = {
  version: 1,
  targetVersion: '1.6.0',
  stage: 'remotes',
  error: null,
  remotes: [
    {
      environmentId: 'one',
      pairingRevision: 1,
      name: 'Build server',
      currentVersion: '1.5.0',
      targetVersion: '1.6.0',
      runtimeId: 'old',
      phase: 'downloading',
      progress: 64,
      error: null
    }
  ]
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    restoreAppUpdate: vi.fn(async () => undefined),
    discoverAppUpdateRemotes: vi.fn(async () => undefined)
  })
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

function renderControls() {
  render(
    <TooltipProvider>
      <UpdateCard />
      <UpdateStatusSegment compact={false} iconOnly={false} />
    </TooltipProvider>
  )
}

it('keeps one bar when details expand, and restores the same card from its status segment after progress changes', () => {
  useAppStore.setState({
    appUpdateBatch: batch,
    appUpdateRunning: true,
    updateStatus: { state: 'downloading', percent: 45, version: '1.6.0' }
  })
  renderControls()
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  expect(screen.queryByText('Build server')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show update details' }))
  expect(screen.getByText('Build server')).toBeTruthy()
  expect(screen.getByText('Downloading… 64%')).toBeTruthy()
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Minimize update' }))
  expect(screen.queryByRole('progressbar')).toBeNull()
  act(() => useAppStore.getState().setUpdateStatus({ state: 'downloaded', version: '1.6.0' }))
  expect(screen.queryByRole('progressbar')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Updating Orca. Click to expand.' }))
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
})

it('shows a persistent warning and offers Check again and Okay with the consequence explained', () => {
  const proceed = vi.fn(async () => undefined)
  const retry = vi.fn(async () => undefined)
  useAppStore.setState({
    appUpdateBatch: {
      ...batch,
      stage: 'attention',
      remotes: batch.remotes.map((remote) => ({
        ...remote,
        phase: 'not-confirmed',
        error: 'Reconnect timed out.'
      }))
    },
    appUpdateRunning: false,
    updateStatus: { state: 'downloaded', version: '1.6.0' },
    continueAppUpdate: proceed,
    retryAppUpdateRemote: retry
  })
  renderControls()
  expect(
    screen.getByRole('button', { name: 'Update needs attention. Click to expand.' })
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show update details' }))
  expect(screen.getByText(/These remotes stay flagged/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  expect(retry).toHaveBeenCalledWith('one')
  fireEvent.click(screen.getByRole('button', { name: 'Okay' }))
  expect(proceed).toHaveBeenCalledOnce()
})

it('opens the full remote list independently from the remembered checkbox', () => {
  const setInclude = vi.fn(async () => undefined)
  useAppStore.setState({
    includeRemotesInAppUpdate: true,
    setIncludeRemotesInAppUpdate: setInclude,
    appUpdateCandidates: batch.remotes.map((remote) => ({
      ...remote,
      phase: 'available',
      supportsPinnedInstall: true,
      support: null,
      liveTabCount: 1,
      liveLeafCount: 1
    }))
  })
  render(<IncludeRemotes />)
  fireEvent.click(screen.getByRole('button', { name: 'Show remotes that will be updated' }))
  expect(screen.getByText('Build server')).toBeTruthy()
  expect(screen.getByText('1.5.0 → 1.6.0')).toBeTruthy()
  expect(setInclude).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include remotes' }))
  expect(setInclude).toHaveBeenCalledWith(false)
})
