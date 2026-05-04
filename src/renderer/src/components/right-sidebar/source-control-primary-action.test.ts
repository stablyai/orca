import { describe, expect, it } from 'vitest'
import { resolvePrimaryAction, type PrimaryActionInputs } from './source-control-primary-action'

// Why: a shared defaults object keeps each case row terse while making the
// "this is the one knob that differs from the baseline" intent obvious.
function inputs(overrides: Partial<PrimaryActionInputs> = {}): PrimaryActionInputs {
  return {
    stagedCount: 0,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: undefined,
    ...overrides
  }
}

const upstreamInSync = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 0,
  behind: 0
}

describe('resolvePrimaryAction', () => {
  it('returns a disabled Commit while a commit is in flight', () => {
    const result = resolvePrimaryAction(
      inputs({ isCommitting: true, stagedCount: 1, hasMessage: true })
    )
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Commit in progress…',
      disabled: true
    })
  })

  it('keeps the contextual label but disables it while a remote op is in flight', () => {
    const result = resolvePrimaryAction(
      inputs({
        isRemoteOperationActive: true,
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 3 }
      })
    )
    expect(result).toEqual({
      kind: 'pull',
      label: 'Pull',
      title: 'Remote operation in progress…',
      disabled: true
    })
  })

  it('blocks commits while unresolved conflicts exist', () => {
    const result = resolvePrimaryAction(
      inputs({ hasUnresolvedConflicts: true, stagedCount: 2, hasMessage: true })
    )
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Resolve conflicts before committing',
      disabled: true
    })
  })

  it('returns a plain Commit when upstream status has not resolved yet', () => {
    // Why: until fetchUpstreamStatus lands for the worktree we don't know the
    // true remote state. Falling back to a plain Commit prevents flashing
    // Commit & Publish before the real status arrives.
    const result = resolvePrimaryAction(
      inputs({ stagedCount: 1, hasMessage: true, upstreamStatus: undefined })
    )
    expect(result.kind).toBe('commit')
    expect(result.label).toBe('Commit')
    expect(result.disabled).toBe(false)
  })

  it('offers Commit & Publish for staged+message when no upstream', () => {
    const result = resolvePrimaryAction(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
      })
    )
    expect(result.kind).toBe('commit_publish')
    expect(result.label).toBe('Commit & Publish')
    expect(result.disabled).toBe(false)
  })

  it('offers Commit & Sync for staged+message when behind > 0', () => {
    const result = resolvePrimaryAction(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: { hasUpstream: true, ahead: 2, behind: 1 }
      })
    )
    expect(result.kind).toBe('commit_sync')
    expect(result.label).toBe('Commit & Sync')
    // Why: compound commit labels/tooltips drop the pre-commit counts — the
    // commit itself bumps ahead by at least one, so surfacing stale numbers
    // would mislead the user.
    expect(result.title).toBe('Commit staged changes, then pull and push')
  })

  it('offers Commit & Push for staged+message when upstream is ahead-only or in sync', () => {
    const result = resolvePrimaryAction(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: upstreamInSync
      })
    )
    expect(result.kind).toBe('commit_push')
    expect(result.label).toBe('Commit & Push')
  })

  it('disables Commit with a message-needed hint when staged but no message', () => {
    const result = resolvePrimaryAction(inputs({ stagedCount: 1, hasMessage: false }))
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Enter a commit message to commit',
      disabled: true
    })
  })

  it('returns Publish Branch on a clean tree when no upstream exists', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 } })
    )
    expect(result).toEqual({
      kind: 'publish',
      label: 'Publish Branch',
      title: 'Publish this branch to origin',
      disabled: false
    })
  })

  it('returns Sync when clean + tracked + diverged both ways', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 2, behind: 3 } })
    )
    expect(result).toEqual({
      kind: 'sync',
      label: 'Sync',
      title: 'Pull 3, push 2',
      disabled: false
    })
  })

  it('returns Pull when clean + behind-only', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 4 } })
    )
    expect(result.kind).toBe('pull')
    expect(result.label).toBe('Pull')
    expect(result.title).toBe('Pull 4 commits')
  })

  it('uses singular copy for a single-commit pull', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 0, behind: 1 } })
    )
    expect(result.title).toBe('Pull 1 commit')
  })

  it('returns Push when clean + ahead-only', () => {
    const result = resolvePrimaryAction(
      inputs({ upstreamStatus: { hasUpstream: true, ahead: 3, behind: 0 } })
    )
    expect(result).toEqual({
      kind: 'push',
      label: 'Push',
      title: 'Push 3 commits',
      disabled: false
    })
  })

  it('returns a disabled up-to-date Commit when tracked branch is clean and in sync', () => {
    const result = resolvePrimaryAction(inputs({ upstreamStatus: upstreamInSync }))
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Nothing to commit. Branch is up to date.',
      disabled: true
    })
  })

  it('returns a disabled Commit when clean and upstream status not yet resolved', () => {
    const result = resolvePrimaryAction(inputs())
    expect(result).toEqual({
      kind: 'commit',
      label: 'Commit',
      title: 'Stage at least one file to commit',
      disabled: true
    })
  })
})
