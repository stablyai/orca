import { describe, expect, it } from 'vitest'
import { resolveTrustedStartupPrompt } from './full-submit-source-preparation'

describe('resolveTrustedStartupPrompt', () => {
  const args = {
    templatePrompt: 'Review https://x/pull/1',
    plainPrompt: 'https://x/pull/1',
    applyTemplate: true,
    templateIsRepoText: true
  }

  it('uses the template when it was trusted', () => {
    expect(resolveTrustedStartupPrompt({ ...args, trustDecision: 'run' })).toBe(
      'Review https://x/pull/1'
    )
  })

  // The trust hole: an unconfirmed shared orca.yaml template must not reach the agent. With no
  // execution host id the confirm block never runs, so the decision stays at its default-deny
  // 'skip' and the template is dropped. This is the case the old code got wrong.
  it('drops repository text when trust was not granted', () => {
    expect(resolveTrustedStartupPrompt({ ...args, trustDecision: 'skip' })).toBe('https://x/pull/1')
  })

  // A failed read (pre-reviewCommand remote host, transient SSH error), a non-git folder workspace,
  // and a repo with no template all leave the built-in default — a local constant, never repo text.
  it('keeps the built-in default even when trust was not granted', () => {
    expect(
      resolveTrustedStartupPrompt({ ...args, templateIsRepoText: false, trustDecision: 'skip' })
    ).toBe('Review https://x/pull/1')
  })

  it('leaves the ordinary prompt alone when no template applies', () => {
    expect(
      resolveTrustedStartupPrompt({
        ...args,
        applyTemplate: false,
        templateIsRepoText: false,
        trustDecision: 'run'
      })
    ).toBe('https://x/pull/1')
  })
})
