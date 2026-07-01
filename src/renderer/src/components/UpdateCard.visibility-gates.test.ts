import { describe, expect, it } from 'vitest'
import { shouldShowUpdateCard, type UpdateCardVisibilityInput } from './update-card-visibility'

const RICH_CHANGELOG = {
  release: {
    title: 'Inline Diffs',
    description: 'Review diffs without leaving the terminal.',
    mediaUrl: 'https://onorca.dev/media/inline-diffs.png',
    releaseNotesUrl: 'https://onorca.dev/changelog/1.2.0'
  },
  releasesBehind: 3
}

type VisibilityInput = Omit<
  UpdateCardVisibilityInput,
  'updateUserInitiatedCycle' | 'autoDismissed' | 'errorDismissed' | 'collapsed'
> &
  Partial<
    Pick<
      UpdateCardVisibilityInput,
      'updateUserInitiatedCycle' | 'autoDismissed' | 'errorDismissed' | 'collapsed'
    >
  >

type VisibilityResult = 'hidden' | 'visible'

function computeVisibility(input: VisibilityInput): VisibilityResult {
  return shouldShowUpdateCard({
    ...input,
    updateUserInitiatedCycle: input.updateUserInitiatedCycle ?? false,
    autoDismissed: input.autoDismissed ?? false,
    errorDismissed: input.errorDismissed ?? false,
    collapsed: input.collapsed ?? false
  })
    ? 'visible'
    : 'hidden'
}

describe('UpdateCard visibility gates', () => {
  it('hides on idle', () => {
    expect(
      computeVisibility({
        status: { state: 'idle' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('hides background checking (not user-initiated)', () => {
    expect(
      computeVisibility({
        status: { state: 'checking' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows user-initiated checking', () => {
    expect(
      computeVisibility({
        status: { state: 'checking', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides background not-available', () => {
    expect(
      computeVisibility({
        status: { state: 'not-available' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows user-initiated not-available (before auto-dismiss)', () => {
    expect(
      computeVisibility({
        status: { state: 'not-available', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides user-initiated not-available after auto-dismiss', () => {
    expect(
      computeVisibility({
        status: { state: 'not-available', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false,
        autoDismissed: true
      })
    ).toBe('hidden')
  })

  it('shows available update (simple mode)', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.2.0', changelog: null },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows available update (rich mode)', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.2.0', changelog: RICH_CHANGELOG },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides available when version is dismissed', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.2.0', changelog: null },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows dismissed available update when a lazy-mounted manual check cycle reaches available', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.2.0', changelog: null },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: false,
        updateUserInitiatedCycle: true
      })
    ).toBe('visible')
  })

  it('shows downloading even when version is dismissed (user clicked Update after dismiss)', () => {
    expect(
      computeVisibility({
        status: { state: 'downloading', percent: 42, version: '1.2.0' },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: true
      })
    ).toBe('visible')
  })

  it('hides downloaded when version is dismissed (Settings-initiated, not card)', () => {
    expect(
      computeVisibility({
        status: { state: 'downloaded', version: '1.2.0' },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('hides background errors silently', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'network' },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })

  it('shows user-initiated check errors', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'network', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides errors explicitly closed from the error card', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'network', userInitiated: true },
        dismissedVersion: null,
        cachedVersion: null,
        hasStartedDownload: false,
        errorDismissed: true
      })
    ).toBe('hidden')
  })

  it('shows card-initiated download errors', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'ENOSPC' },
        dismissedVersion: null,
        cachedVersion: '1.2.0',
        hasStartedDownload: true
      })
    ).toBe('visible')
  })

  it('shows settings-initiated download errors when a version is cached', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'ENOSPC' },
        dismissedVersion: null,
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows downloaded for card-initiated downloads', () => {
    expect(
      computeVisibility({
        status: { state: 'downloaded', version: '1.2.0' },
        dismissedVersion: null,
        cachedVersion: '1.2.0',
        hasStartedDownload: true
      })
    ).toBe('visible')
  })

  it('hides in-progress update states while collapsed to the status bar', () => {
    expect(
      computeVisibility({
        status: { state: 'downloading', percent: 42, version: '1.2.0' },
        dismissedVersion: null,
        cachedVersion: '1.2.0',
        hasStartedDownload: true,
        collapsed: true
      })
    ).toBe('hidden')
  })

  it('re-shows card for a newer version even if an older version was dismissed', () => {
    expect(
      computeVisibility({
        status: { state: 'available', version: '1.3.0', changelog: null },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.3.0',
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('shows error for dismissed version when an active update action fails', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'fail', userInitiated: true },
        dismissedVersion: '1.2.0',
        cachedVersion: '1.2.0',
        hasStartedDownload: false
      })
    ).toBe('visible')
  })

  it('hides check errors once a new checking cycle cleared the cached version', () => {
    expect(
      computeVisibility({
        status: { state: 'error', message: 'network timeout' },
        dismissedVersion: '1.2.0',
        cachedVersion: null,
        hasStartedDownload: false
      })
    ).toBe('hidden')
  })
})
