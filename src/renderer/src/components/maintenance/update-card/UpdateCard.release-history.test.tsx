// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../../store/index'
import { UpdateCard } from './UpdateCard'
import { NotificationCardStack } from '../../notifications/NotificationCardStack'

const openUrl = vi.fn()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  openUrl.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { openUrl },
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      updater: { download: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('UpdateCard release history', () => {
  it('pages through the releases since the installed version', () => {
    useAppStore.setState({
      updateStatus: {
        state: 'available',
        version: '1.4.261',
        changelog: null,
        releaseHistory: {
          installedVersion: '1.4.258',
          newerReleaseCount: 2,
          releases: [
            {
              version: '1.4.261',
              publishedAt: '2026-11-16T10:30:50Z',
              notes: '- **Cursor** joins Chat',
              releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.261'
            },
            {
              version: '1.4.259',
              publishedAt: '2026-11-12T09:00:00Z',
              notes: 'Workspace cleanup',
              releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.259'
            }
          ]
        }
      },
      updateReassuranceSeen: true
    })
    render(
      <NotificationCardStack>
        <UpdateCard />
      </NotificationCardStack>
    )

    expect(screen.getByText(/v1\.4\.258 · 2 new releases/)).toBeTruthy()
    expect(screen.getByText('v1.4.261')).toBeTruthy()
    expect(screen.getByText('Cursor')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Release notes' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Older release' }))

    expect(screen.getByText('v1.4.259')).toBeTruthy()
    expect(screen.getByText('Workspace cleanup')).toBeTruthy()
    expect(screen.getByText('2 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View on GitHub' }))
    expect(openUrl).toHaveBeenCalledWith('https://github.com/stablyai/orca/releases/tag/v1.4.259')
  })
})
