import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import { cloneAccessActions, cloneAccessCopy } from './clone-access-actions'
import type { CloneAccessPhase } from './use-clone-access-handoff'

const REPO = 'stablyai/orca-plugins'

function row(phase: CloneAccessPhase) {
  const handlers = { onRetry: vi.fn(), onChooseAnotherRepo: vi.fn() }
  const access = { phase, giveAccess: vi.fn(), copyRequest: vi.fn() }
  return { actions: cloneAccessActions(access, handlers, translate), handlers, access }
}

describe('CLONE-ACCESS-ERROR card', () => {
  it('names the cause and offers to fix access, with another repository as the way around', () => {
    expect(cloneAccessCopy('missing', REPO, translate).title).toBe(
      'Orca can’t access stablyai/orca-plugins'
    )
    const { actions, access, handlers } = row('missing')
    expect(actions.map((action) => action.label)).toEqual([
      'Give Orca access',
      'Choose another repository'
    ])
    // The App's install page is a plain button: no Copy link (AUTH-ONLY-COPY-LINK).
    expect(actions[0]).not.toHaveProperty('link')
    actions[0]?.onClick()
    expect(access.giveAccess).toHaveBeenCalledOnce()
    actions[1]?.onClick()
    expect(handlers.onChooseAnotherRepo).toHaveBeenCalledOnce()
    expect(actions[1]?.secondary).toBe(true)
  })

  it('while waiting, the fix reads as in progress', () => {
    const [first] = row('waiting').actions
    expect(first).toMatchObject({ label: 'Waiting for GitHub…', pending: true })
  })

  it('someone who can’t install is told who to ask, with a request to send', () => {
    expect(cloneAccessCopy('requested', REPO, translate).body).toContain(
      'Ask an owner of stablyai to give Orca access'
    )
    const { actions, access } = row('requested')
    expect(actions[0]?.label).toBe('Copy request for an owner')
    actions[0]?.onClick()
    expect(access.copyRequest).toHaveBeenCalledOnce()
    const copied = cloneAccessActions(
      { phase: 'requested', giveAccess: vi.fn(), copyRequest: vi.fn(), copied: true },
      { onRetry: vi.fn(), onChooseAnotherRepo: vi.fn() },
      translate
    )
    expect(copied[0]?.label).toBe('Copied')
  })

  it('reachable now: a plain Try again', () => {
    expect(cloneAccessCopy('reachable', REPO, translate).title).toBe(
      'Couldn’t clone stablyai/orca-plugins'
    )
    const { actions, handlers } = row('reachable')
    expect(actions[0]?.label).toBe('Try again')
    actions[0]?.onClick()
    expect(handlers.onRetry).toHaveBeenCalledOnce()
  })
})
