import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  createFakeRebaseRepo,
  installFakeRebaseGit,
  RebaseRowInteractionHarness,
  type FakeRebaseRepoState
} from './rebase-row-interaction.test-fixture'

// Live fixtures: the shipped row, store and hooks over a fake repository, for driving in a browser.
// The fake answers after a short delay so spinners and busy states are visible between steps.
function liveRow(id: string, initial: Partial<FakeRebaseRepoState>, width = 380) {
  const repo = createFakeRebaseRepo(initial, { delayMs: 250 })
  return defineFixture({
    width,
    setup: () => installFakeRebaseGit(repo),
    render: () => <RebaseRowInteractionHarness repo={repo} worktreeId={`fixture-${id}`} />
  })
}

/** Behind origin/main: Rebase, then two conflicts to resolve (via window.__fakeRebaseRepo). */
export const behind = (() => {
  const repo = createFakeRebaseRepo({}, { delayMs: 250 })
  return defineFixture({
    width: 380,
    setup: () => {
      installFakeRebaseGit(repo)
      Object.assign(window, { __fakeRebaseRepo: repo })
    },
    render: () => <RebaseRowInteractionHarness repo={repo} worktreeId="fixture-behind" />
  })
})()

/** The automatic step check failed (stopped WSL distro); Retry reads it again. */
export const inspectFailed = liveRow('inspect-failed', {
  paused: true,
  step: 1,
  head: 'h1',
  inspectFailuresLeft: 1
})

/** An empty step after Continue: Skip moves on. */
export const emptyStep = liveRow('empty-step', {
  paused: true,
  step: 1,
  head: 'h1',
  emptyStep: true
})

export const pausedNarrow = liveRow(
  'paused-narrow',
  { paused: true, step: 1, head: 'h1', unresolved: 2 },
  240
)
