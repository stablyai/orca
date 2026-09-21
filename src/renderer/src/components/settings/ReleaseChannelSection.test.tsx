// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ReleaseChannelSection } from './ReleaseChannelSection'

describe('ReleaseChannelSection', () => {
  const listBuildsMock = vi.fn()
  const getVersionMock = vi.fn()

  beforeEach(() => {
    listBuildsMock.mockReset()
    getVersionMock.mockReset()
    getVersionMock.mockResolvedValue('1.4.205')
    listBuildsMock.mockResolvedValue({
      ok: true,
      channel: 'stable',
      builds: [
        {
          tag: 'v1.4.205',
          version: '1.4.205',
          channel: 'stable',
          name: null,
          publishedAt: '2026-09-20T00:00:00Z',
          releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.205',
          installerUrl: null
        }
      ]
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        updater: {
          getVersion: getVersionMock,
          listBuilds: listBuildsMock,
          check: vi.fn()
        },
        shell: {
          openUrl: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('loads builds for the active channel on mount', async () => {
    render(
      <TooltipProvider>
        <ReleaseChannelSection />
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(listBuildsMock).toHaveBeenCalledWith('stable', undefined)
    })
    expect(screen.getByText('Release channel')).toBeTruthy()
  })

  it('triggers a force refresh when clicking the refresh button', async () => {
    render(
      <TooltipProvider>
        <ReleaseChannelSection />
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(listBuildsMock).toHaveBeenCalledTimes(1)
    })

    const refreshButton = screen.getByRole('button', { name: 'Refresh build list' })
    fireEvent.click(refreshButton)

    await waitFor(() => {
      expect(listBuildsMock).toHaveBeenCalledTimes(2)
      expect(listBuildsMock).toHaveBeenLastCalledWith('stable', { force: true })
    })
  })

  it('renders error message when listBuilds fails with rate limit', async () => {
    listBuildsMock.mockResolvedValue({
      ok: false,
      channel: 'stable',
      message: 'GitHub rate limit reached. Resets in 12 minutes.'
    })

    render(
      <TooltipProvider>
        <ReleaseChannelSection />
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(
        screen.getByText('GitHub rate limit reached. Resets in 12 minutes.')
      ).toBeTruthy()
    })
  })
})
