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

  it('renders note headings as blocks and drops inline HTML images', () => {
    const mascot =
      '<img src="https://raw.githubusercontent.com/stablyai/orca/main/src/shared/bot-mascots/A1.webp" alt="Orca" width="36" height="36" valign="middle" />'
    useAppStore.setState({
      updateStatus: {
        state: 'available',
        version: '1.4.266',
        changelog: null,
        releaseHistory: {
          installedVersion: '1.4.265',
          newerReleaseCount: 1,
          releases: [
            {
              version: '1.4.266',
              publishedAt: '2026-11-19T10:00:00Z',
              notes: `## Introducing Orca Bots ${mascot}\n\nOrca Bots work like teammates.\n\n- ${mascot} **Every bot session** gets its tools\n\nEmbed with \`<img src="logo.png">\` inline.\n\n\`\`\`html\n<img src="banner.png" alt="Banner">\n\`\`\``,
              releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.266'
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

    const heading = screen.getByRole('heading', { level: 2 })
    expect(heading.textContent?.trim()).toBe('Introducing Orca Bots')
    const paragraph = screen.getByText('Orca Bots work like teammates.')
    expect(heading.contains(paragraph)).toBe(false)
    const notes = heading.parentElement
    expect(notes?.className).toContain('[&_.comment-md-h]:block')
    expect(notes?.className).toContain('[&_.comment-md-p]:block')
    expect(screen.getByText('Every bot session')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Orca' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(notes?.textContent).not.toContain('Orca Orca')
    // Images inside code examples are content, not decoration.
    expect(screen.getByText('<img src="logo.png">')).toBeTruthy()
    expect(notes?.textContent).toContain('<img src="banner.png" alt="Banner">')
  })
})
