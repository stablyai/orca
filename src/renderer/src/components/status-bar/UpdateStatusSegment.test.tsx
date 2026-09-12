// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../../../shared/update-status-types'
import { useAppStore } from '../../store'
import { UpdateCard } from '../UpdateCard'
import { TooltipProvider } from '../ui/tooltip'
import { UpdateStatusSegment } from './UpdateStatusSegment'

const check = vi.fn()
const message = 'Could not reach the update server: net::ERR_CONNECTION_REFUSED'
const error: UpdateStatus = { state: 'error', message }
const actionableErrors: UpdateStatus[] = [
  { ...error, userInitiated: true },
  { ...error, version: '1.4.200' },
  {
    ...error,
    recovery: {
      kind: 'linux-package-install',
      packageType: 'deb',
      reason: 'manual-install-required',
      version: '1.4.200'
    }
  }
]

function setStatus(status: UpdateStatus): void {
  act(() => useAppStore.getState().setUpdateStatus(status))
}

function renderUpdateControls(): void {
  render(
    <TooltipProvider>
      <UpdateCard />
      <UpdateStatusSegment compact={false} iconOnly={false} />
    </TooltipProvider>
  )
}

function errorToggle(): HTMLElement {
  return screen.getByRole('button', { name: 'Update failed. Click to expand.' })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  check.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { updater: { check } }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

describe('update status disclosure', () => {
  it('opens background check failure details on the first click and offers a re-check', () => {
    renderUpdateControls()
    setStatus({ state: 'checking' })
    setStatus(error)

    expect(screen.queryByRole('complementary', { name: 'Update error' })).toBeNull()
    fireEvent.click(errorToggle())

    expect(screen.getByRole('complementary', { name: 'Update error' })).toBeTruthy()
    expect(errorToggle().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText(message)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    expect(check).toHaveBeenCalledWith({ includePrerelease: false })

    fireEvent.click(errorToggle())
    expect(screen.queryByRole('complementary', { name: 'Update error' })).toBeNull()
    expect(errorToggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('announces a quiet automatic check failure as collapsed', () => {
    setStatus(error)
    renderUpdateControls()

    expect(screen.queryByRole('complementary', { name: 'Update error' })).toBeNull()
    expect(errorToggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('preserves the disclosure choice until the next automatic check', () => {
    renderUpdateControls()
    setStatus(error)
    fireEvent.click(errorToggle())
    setStatus({ ...error, message: 'Still unavailable' })
    expect(screen.getByRole('complementary', { name: 'Update error' })).toBeTruthy()

    fireEvent.click(errorToggle())
    setStatus(error)
    expect(screen.queryByRole('complementary', { name: 'Update error' })).toBeNull()
    fireEvent.click(errorToggle())

    setStatus({ state: 'checking' })
    setStatus(error)
    expect(screen.queryByRole('complementary', { name: 'Update error' })).toBeNull()
    expect(errorToggle().getAttribute('aria-expanded')).toBe('false')
  })

  it.each<UpdateStatus>([
    { state: 'checking', userInitiated: true },
    { state: 'available', version: '1.4.200', changelog: null },
    { state: 'downloading', version: '1.4.200', percent: 50 },
    { state: 'downloaded', version: '1.4.200' }
  ])('opens an error after $state without requiring a status click', (previousStatus) => {
    setStatus(previousStatus)
    setStatus(error)
    renderUpdateControls()

    expect(screen.getByRole('complementary', { name: 'Update error' })).toBeTruthy()
    expect(errorToggle().getAttribute('aria-expanded')).toBe('true')
  })

  it.each(actionableErrors)(
    'opens an explicit actionable error on initial receipt: %j',
    (status) => {
      setStatus(status)
      renderUpdateControls()

      expect(screen.getByRole('complementary', { name: 'Update error' })).toBeTruthy()
      expect(
        screen.getByRole('button', { name: /Click to expand/ }).getAttribute('aria-expanded')
      ).toBe('true')
    }
  )

  it.each(actionableErrors)(
    'opens a newly actionable error and preserves dismissal on repeat: %j',
    (status) => {
      renderUpdateControls()
      setStatus(error)
      expect(screen.queryByRole('complementary', { name: 'Update error' })).toBeNull()

      setStatus(status)
      expect(screen.getByRole('complementary', { name: 'Update error' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: /Click to expand/ }))
      setStatus({ ...status })
      expect(screen.queryByRole('complementary', { name: 'Update error' })).toBeNull()
    }
  )
})
