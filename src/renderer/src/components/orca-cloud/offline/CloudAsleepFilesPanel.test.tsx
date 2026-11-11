// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudOfflineSnapshot } from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { CloudAsleepFilesPanel, changeStatusLetter, formatWhen } from './CloudAsleepFilesPanel'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
vi.mock('@/hooks/use-now', () => ({ useNow: () => NOW }))

// English defaults with {{slots}} filled, like i18next with no catalog.
const t = (_key: string, fallback: string, params?: Record<string, unknown>): string =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_slot, name: string) => String(params?.[name] ?? ''))

function serve(snapshot: CloudOfflineSnapshot | null): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      orcaCloudOffline: {
        getSnapshot: async () => snapshot,
        listQueuedPrompts: async () => [],
        onQueuedPromptsChanged: () => () => {}
      }
    }
  })
}

afterEach(() => {
  cleanup()
})

const snapshot = (git: CloudOfflineSnapshot['git']): CloudOfflineSnapshot => ({
  workspaceId: 'ws',
  asleep: true,
  capturedAt: NOW - 47_000,
  git,
  terminals: [],
  chats: []
})

describe('asleep Files tab (RA-10)', () => {
  it('shows recent times relatively and old ones as a date', () => {
    expect(formatWhen(NOW - 47_000, NOW, 'en-US', t)).toBe('47s ago')
    expect(formatWhen(NOW - 5362 * DAY, NOW, 'en-US', t)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)
  })

  it('shows a change status as one letter, like the explorer (the snapshot says "modified")', () => {
    expect(
      ['modified', 'untracked', 'added', 'deleted', 'renamed', '?', 'M'].map(changeStatusLetter)
    ).toEqual(['M', 'U', 'A', 'D', 'R', 'U', 'M'])
  })

  it('lists changed files, then recent commits on the branch, then Wake', async () => {
    serve(
      snapshot({
        branch: 'master',
        head: 'abc',
        at: NOW - 47_000,
        changeCount: 2,
        changes: [
          { path: 'README.md', status: 'M', area: 'unstaged' },
          { path: 'notes.txt', status: '?', area: 'untracked' }
        ],
        commits: [
          {
            id: '7fd1a60b01f91b3',
            subject: 'Merge pull request #6',
            author: null,
            at: NOW - 5362 * DAY
          }
        ]
      })
    )
    const { container } = render(<CloudAsleepFilesPanel workspaceId="ws" />)
    await waitFor(() => expect(container.textContent).toContain('README.md'))
    const text = container.textContent ?? ''
    expect(text).toContain('Changed files when this workspace went to sleep')
    expect(text).toContain('notes.txt')
    expect(text).toContain('Recent commits on master')
    expect(text).not.toContain('days ago')
    expect(text.indexOf('README.md')).toBeLessThan(text.indexOf('Recent commits on master'))
    expect(text).toContain('Wake')
  })

  it('says nothing had changed for a clean tree, and still lists the commits', async () => {
    serve(
      snapshot({
        branch: 'master',
        head: 'abc',
        at: NOW - 47_000,
        changeCount: 0,
        changes: [],
        commits: [{ id: '553c2077f0edc3d5', subject: 'first commit', author: null, at: NOW - DAY }]
      })
    )
    const { container } = render(<CloudAsleepFilesPanel workspaceId="ws" />)
    await waitFor(() => expect(container.textContent).toContain('first commit'))
    expect(container.textContent).toContain(
      'No files had changed when this workspace went to sleep · 47s ago'
    )
    expect(container.textContent).not.toContain('Changed files when')
  })

  it('without a snapshot: the neutral note and Wake', async () => {
    serve(null)
    const { container } = render(<CloudAsleepFilesPanel workspaceId="ws" />)
    await waitFor(() =>
      expect(container.textContent).toContain(
        'Files aren’t available while the workspace is asleep.'
      )
    )
    expect(
      container.querySelector('[data-cloud-asleep-files]')?.getAttribute('data-cloud-asleep-files')
    ).toBe('none')
  })

  it('archived: says "archived", never "went to sleep", and offers no Wake (DS-h)', async () => {
    serve(
      snapshot({
        branch: 'master',
        head: 'abc',
        at: NOW - 47_000,
        changeCount: 1,
        changes: [{ path: 'README.md', status: 'M', area: 'unstaged' }],
        commits: []
      })
    )
    const { container } = render(<CloudAsleepFilesPanel workspaceId="ws" archived />)
    await waitFor(() => expect(container.textContent).toContain('README.md'))
    const text = container.textContent ?? ''
    expect(text).toContain('Changed files when this workspace was archived · 47s ago')
    expect(text).toContain('Unarchive the workspace to browse all its files.')
    expect(text).not.toContain('sleep')
    expect(container.querySelector('button')).toBeNull()
  })

  it('archived without a snapshot: the archived note, no Wake', async () => {
    serve(null)
    const { container } = render(<CloudAsleepFilesPanel workspaceId="ws" archived />)
    await waitFor(() =>
      expect(container.textContent).toContain(
        'Files aren’t available while the workspace is archived.'
      )
    )
    expect(container.querySelector('button')).toBeNull()
  })
})
