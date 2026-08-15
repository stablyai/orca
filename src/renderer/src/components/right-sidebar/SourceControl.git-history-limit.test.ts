import { describe, expect, it } from 'vitest'
import { GIT_HISTORY_DEFAULT_LIMIT, GIT_HISTORY_MAX_LIMIT } from '../../../../shared/git-history'
import { resolveNextGitHistoryLimit } from './SourceControl'

describe('resolveNextGitHistoryLimit', () => {
  it('steps up one page from the default when nothing has landed yet', () => {
    expect(resolveNextGitHistoryLimit(undefined)).toBe(
      GIT_HISTORY_DEFAULT_LIMIT + GIT_HISTORY_DEFAULT_LIMIT
    )
  })

  it('steps up one page from the landed limit', () => {
    expect(resolveNextGitHistoryLimit(100)).toBe(150)
  })

  it('clamps the final page to the git layer maximum', () => {
    expect(resolveNextGitHistoryLimit(GIT_HISTORY_MAX_LIMIT - 10)).toBe(GIT_HISTORY_MAX_LIMIT)
  })

  it('reports no further page once the landed limit is at the maximum', () => {
    expect(resolveNextGitHistoryLimit(GIT_HISTORY_MAX_LIMIT)).toBeNull()
  })

  // Why: refreshGitHistory catches its own errors, so a failed Load more never rolls the limit
  // back. Stepping off the landed limit means repeated failures re-request the SAME page instead
  // of escalating 50 -> 100 -> 150 -> 200 and then silently refusing to request anything at all
  // while the button is still on screen.
  // Why: the wedge this guards against came from the button's gate and the step rule reading
  // DIFFERENT limits — the gate read the landed result while the step read the requested ref, so
  // the button stayed lit after the step had already refused to request anything. Pin them to the
  // same answer for every reachable limit so they cannot drift apart again.
  it('refuses a further page exactly when the panel stops offering one', () => {
    for (let landed = GIT_HISTORY_DEFAULT_LIMIT; landed <= GIT_HISTORY_MAX_LIMIT; landed += 10) {
      const panelOffersLoadMore = landed < GIT_HISTORY_MAX_LIMIT
      const stepHasAnotherPage = resolveNextGitHistoryLimit(landed) !== null
      expect({ landed, stepHasAnotherPage }).toEqual({
        landed,
        stepHasAnotherPage: panelOffersLoadMore
      })
    }
  })

  it('does not escalate when the refresh keeps failing and nothing new lands', () => {
    const landed = GIT_HISTORY_DEFAULT_LIMIT
    const attempts = [
      resolveNextGitHistoryLimit(landed),
      resolveNextGitHistoryLimit(landed),
      resolveNextGitHistoryLimit(landed),
      resolveNextGitHistoryLimit(landed)
    ]

    expect(attempts).toEqual([100, 100, 100, 100])
    expect(attempts.every((attempt) => attempt !== null)).toBe(true)
  })
})
