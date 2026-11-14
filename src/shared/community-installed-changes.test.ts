import { expect, test } from 'vitest'
import {
  communityInstalledChanges,
  type CommunityInstalledSnapshot
} from './community-installed-changes'
import type { CommunityPullRequest } from './community-catalog'

const proposal: CommunityPullRequest = {
  number: 41731,
  title: 'Community browser',
  displayTitle: 'Community browser',
  url: 'https://github.com/stablyai/orca/pull/41731',
  author: 'Vegas97',
  createdAt: '2026-11-13T10:00:00Z',
  updatedAt: '2026-11-14T10:00:00Z',
  isDraft: false,
  kind: 'Features',
  area: 'Community',
  comments: null,
  prThumbsUp: null,
  closingIssues: [],
  headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  reviewDecision: null,
  checkState: null,
  checkObserved: false,
  additions: null,
  deletions: null,
  changedFiles: null,
  imageUrls: ['https://example.com/current-pr.png'],
  state: 'open'
}
const snapshot: CommunityInstalledSnapshot = {
  build: {
    id: 'custom-four',
    baseVersion: '1.4.257',
    profileMode: 'isolated-preview',
    changes: [
      { id: 'keychain', title: 'Custom encryption', description: 'Separate credential identity.' },
      {
        id: 'community',
        title: 'Community browser',
        description: 'Activity, Changelog, and image gallery.',
        imageUrls: ['https://example.com/build-preview.png'],
        pullRequest: {
          number: 41731,
          headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          url: 'https://github.com/stablyai/orca/pull/41731'
        }
      },
      {
        id: 'other',
        title: 'Another change',
        pullRequest: {
          number: 4173,
          headSha: 'cccccccccccccccccccccccccccccccccccccccc',
          url: 'https://github.com/stablyai/orca/pull/4173'
        }
      }
    ]
  },
  sources: [proposal],
  unavailable: [4173]
}

test('installed previews and source identity survive a newer PR head', () => {
  const installed = communityInstalledChanges(snapshot, '#41731')
  expect(installed[0]?.imageUrls).toEqual(['https://example.com/build-preview.png'])
  expect(installed[0]?.previewSource).toBe('manifest')
  expect(installed[0]?.change.pullRequest?.headSha).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  expect(installed[0]?.proposal?.headSha).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
})

test('installed search includes local descriptions and exact PR identities with image filtering', () => {
  expect(communityInstalledChanges(snapshot, 'CREDENTIAL').map((row) => row.change.id)).toEqual([
    'keychain'
  ])
  expect(communityInstalledChanges(snapshot, 'gallery').map((row) => row.change.id)).toEqual([
    'community'
  ])
  expect(communityInstalledChanges(snapshot, '#4173').map((row) => row.change.id)).toEqual([
    'other'
  ])
  expect(
    communityInstalledChanges(snapshot, 'https://github.com/stablyai/orca/pull/41731', true).map(
      (row) => row.change.id
    )
  ).toEqual(['community'])
  expect(communityInstalledChanges(snapshot, 'credential', true)).toEqual([])
})

test('offline PR metadata does not hide local or installed changes', () => {
  const offline = communityInstalledChanges({ ...snapshot, sources: [] })
  expect(offline.map((row) => row.change.id)).toEqual(['keychain', 'community', 'other'])
  expect(offline[1]?.imageUrls).toEqual(['https://example.com/build-preview.png'])
  expect(offline[2]?.proposal).toBeNull()
})
