import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from '../../../shared/types'
import {
  createGitHubChecksTabState,
  resolveGitHubChecksTabState,
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

describe('github checks tab state', () => {
  it('preserves local check state while the source checks reference is unchanged', () => {
    const sourceChecks = [check('unit')]
    const state = updateGitHubChecksTabLocalChecks(createGitHubChecksTabState(sourceChecks), [
      check('refreshed')
    ])

    expect(resolveGitHubChecksTabState(state, sourceChecks)).toBe(state)
  })

  it('resets local checks and expanded details when source checks change', () => {
    const oldSource = [check('old')]
    const nextSource = [check('next')]
    const stateWithDetails = updateGitHubChecksTabDetails(
      toggleGitHubChecksTabExpandedKey(
        updateGitHubChecksTabLocalChecks(createGitHubChecksTabState(oldSource), [check('local')]),
        'unit'
      ),
      'unit',
      { loading: true, details: null, error: null }
    )

    expect(resolveGitHubChecksTabState(stateWithDetails, nextSource)).toEqual({
      sourceChecks: nextSource,
      localChecks: null,
      expandedCheckKey: null,
      detailsByCheckKey: {}
    })
  })

  it('toggles expanded check keys without discarding loaded details', () => {
    const sourceChecks = [check('unit')]
    const state = updateGitHubChecksTabDetails(createGitHubChecksTabState(sourceChecks), 'unit', {
      loading: false,
      details: null,
      error: 'No details'
    })

    const expanded = toggleGitHubChecksTabExpandedKey(state, 'unit')
    const collapsed = toggleGitHubChecksTabExpandedKey(expanded, 'unit')

    expect(expanded.expandedCheckKey).toBe('unit')
    expect(collapsed.expandedCheckKey).toBeNull()
    expect(collapsed.detailsByCheckKey).toBe(state.detailsByCheckKey)
  })
})
