import { describe, expect, it } from 'vitest'
import {
  forgetLaunchConfirmation,
  forgetSiblingsOptInLabel,
  isDestructiveRecoveryAction
} from './agent-launch-recovery-action-copy'

describe('forgetLaunchConfirmation', () => {
  it('is a destructive confirmation carrying the plan :498 could-still-be-running warning', () => {
    const options = forgetLaunchConfirmation()
    expect(options.confirmVariant).toBe('destructive')
    expect(options.description).toBe(
      'Orca cannot reach the terminal host. Forgetting does not stop the remote process; it may still be running.'
    )
    expect(options.title).toBe('Forget this launch?')
    expect(options.confirmLabel).toBe('Forget launch')
  })
})

describe('forgetSiblingsOptInLabel', () => {
  it('uses the singular launch phrasing for a single sibling', () => {
    expect(forgetSiblingsOptInLabel(1, 'devbox')).toBe(
      'Also forget 1 other stranded launch on devbox.'
    )
  })

  it('uses the plural phrasing and interpolates the count and host for many siblings', () => {
    expect(forgetSiblingsOptInLabel(3, 'devbox')).toBe(
      'Also forget 3 other stranded launches on devbox.'
    )
  })
})

describe('isDestructiveRecoveryAction', () => {
  it('marks only forget-launch as destructive', () => {
    expect(isDestructiveRecoveryAction('forget-launch')).toBe(true)
    expect(isDestructiveRecoveryAction('retry')).toBe(false)
    expect(isDestructiveRecoveryAction('choose-agent')).toBe(false)
  })
})
