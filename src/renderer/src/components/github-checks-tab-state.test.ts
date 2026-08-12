import { describe, expect, it } from 'vitest'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/types'
import {
  beginGitHubChecksTabDetails,
  createGitHubChecksTabState,
  resolveGitHubChecksTabState,
  settleGitHubChecksTabDetails,
  toggleGitHubChecksTabExpandedKey,
  updateGitHubChecksTabDetails,
  updateGitHubChecksTabLocalChecks
} from './github-checks-tab-state'

const check = (name: string): PRCheckDetail => ({
  name,
  status: 'completed',
  conclusion: 'success',
  url: null
})

const checkRunDetails: PRCheckRunDetails = {
  name: 'unit',
  status: 'completed',
  conclusion: 'failure',
  url: null,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  title: 'Unit tests',
  summary: null,
  text: null,
  annotations: [],
  jobs: []
}

describe('github checks tab state', () => {
  it('preserves local check state while the source checks reference is unchanged', () => {
    const sourceChecks = [check('unit')]
    const state = updateGitHubChecksTabLocalChecks(
      createGitHubChecksTabState(sourceChecks, 'repo-a'),
      [check('refreshed')]
    )

    expect(resolveGitHubChecksTabState(state, sourceChecks, 'repo-a')).toBe(state)
  })

  it('resets local checks and expanded details when source checks change', () => {
    const oldSource = [check('old')]
    const nextSource = [check('next')]
    const stateWithDetails = updateGitHubChecksTabDetails(
      toggleGitHubChecksTabExpandedKey(
        updateGitHubChecksTabLocalChecks(createGitHubChecksTabState(oldSource, 'repo-a'), [
          check('local')
        ]),
        'unit'
      ),
      'unit',
      { loading: true, details: null, error: null }
    )

    expect(resolveGitHubChecksTabState(stateWithDetails, nextSource, 'repo-a')).toEqual({
      contextKey: 'repo-a',
      contextOwner: stateWithDetails.contextOwner,
      sourceChecks: nextSource,
      localChecks: null,
      expandedCheckKey: null,
      detailsByCheckKey: {}
    })
  })

  it('toggles expanded check keys without discarding loaded details', () => {
    const sourceChecks = [check('unit')]
    const state = updateGitHubChecksTabDetails(
      createGitHubChecksTabState(sourceChecks, 'repo-a'),
      'unit',
      {
        loading: false,
        details: null,
        error: 'No details'
      }
    )

    const expanded = toggleGitHubChecksTabExpandedKey(state, 'unit')
    const collapsed = toggleGitHubChecksTabExpandedKey(expanded, 'unit')

    expect(expanded.expandedCheckKey).toBe('unit')
    expect(collapsed.expandedCheckKey).toBeNull()
    expect(collapsed.detailsByCheckKey).toBe(state.detailsByCheckKey)
  })

  it('settles details only for the request that still owns the check key', () => {
    const sourceChecks = [check('unit')]
    const loading = beginGitHubChecksTabDetails(
      createGitHubChecksTabState(sourceChecks, 'repo-a'),
      'unit',
      2
    )

    expect(
      settleGitHubChecksTabDetails(loading, 'unit', 1, {
        loading: false,
        details: null,
        error: 'stale'
      })
    ).toBe(loading)
    expect(
      settleGitHubChecksTabDetails(loading, 'unit', 2, {
        loading: false,
        details: null,
        error: 'current'
      }).detailsByCheckKey.unit
    ).toEqual({ requestId: 2, loading: false, details: null, error: 'current' })
  })

  it('gives a retry ownership over an older in-flight request', () => {
    const sourceChecks = [check('unit')]
    const first = beginGitHubChecksTabDetails(
      createGitHubChecksTabState(sourceChecks, 'repo-a'),
      'unit',
      1
    )
    const retry = beginGitHubChecksTabDetails(first, 'unit', 2)

    expect(retry.detailsByCheckKey.unit).toEqual({
      requestId: 2,
      loading: true,
      details: null,
      error: null
    })

    expect(
      settleGitHubChecksTabDetails(retry, 'unit', 1, {
        loading: false,
        details: null,
        error: 'old failure'
      })
    ).toBe(retry)
    expect(
      settleGitHubChecksTabDetails(retry, 'unit', 2, {
        loading: false,
        details: null,
        error: 'retry failure'
      }).detailsByCheckKey.unit
    ).toEqual({ requestId: 2, loading: false, details: null, error: 'retry failure' })
  })

  it('keeps a retry error visible while the replacement request is loading', () => {
    const sourceChecks = [check('unit')]
    const failed = settleGitHubChecksTabDetails(
      beginGitHubChecksTabDetails(createGitHubChecksTabState(sourceChecks, 'repo-a'), 'unit', 1),
      'unit',
      1,
      { loading: false, details: null, error: 'first failure' }
    )

    expect(beginGitHubChecksTabDetails(failed, 'unit', 2).detailsByCheckKey.unit).toEqual({
      requestId: 2,
      loading: true,
      details: null,
      error: 'first failure'
    })
  })

  it('clears loaded details when a retry starts after a successful load', () => {
    const sourceChecks = [check('unit')]
    const loaded = settleGitHubChecksTabDetails(
      beginGitHubChecksTabDetails(createGitHubChecksTabState(sourceChecks, 'repo-a'), 'unit', 1),
      'unit',
      1,
      { loading: false, details: checkRunDetails, error: null }
    )

    expect(loaded.detailsByCheckKey.unit.details).toBe(checkRunDetails)
    expect(beginGitHubChecksTabDetails(loaded, 'unit', 2).detailsByCheckKey.unit).toEqual({
      requestId: 2,
      loading: true,
      details: null,
      error: null
    })
  })

  it('drops settlement after a source refresh clears request ownership', () => {
    const oldSource = [check('old')]
    const loading = updateGitHubChecksTabDetails(
      createGitHubChecksTabState(oldSource, 'repo-a'),
      'unit',
      {
        requestId: 1,
        loading: true,
        details: null,
        error: null
      }
    )
    const refreshed = resolveGitHubChecksTabState(loading, [check('new')], 'repo-a')

    expect(refreshed.contextOwner).toBe(loading.contextOwner)

    expect(
      settleGitHubChecksTabDetails(refreshed, 'unit', 1, {
        loading: false,
        details: null,
        error: 'stale'
      })
    ).toBe(refreshed)
  })

  it('resets request ownership when the context changes with the same checks array', () => {
    const sourceChecks = [check('unit')]
    const loading = updateGitHubChecksTabDetails(
      createGitHubChecksTabState(sourceChecks, 'repo-a'),
      'unit',
      { requestId: 1, loading: true, details: null, error: null }
    )

    const nextContext = resolveGitHubChecksTabState(loading, sourceChecks, 'repo-b')
    expect(nextContext).toEqual({
      contextKey: 'repo-b',
      contextOwner: expect.any(Object),
      sourceChecks,
      localChecks: null,
      expandedCheckKey: null,
      detailsByCheckKey: {}
    })
    const revisited = resolveGitHubChecksTabState(nextContext, sourceChecks, 'repo-a')
    expect(revisited.contextOwner).not.toBe(loading.contextOwner)
    expect(revisited.contextOwner).not.toBe(nextContext.contextOwner)
  })
})
