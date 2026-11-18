import { describe, expect, it } from 'vitest'
import { zotzCheckoutSwitchTarget } from './use-zotz-composer-worktree-switch'

describe('zotzCheckoutSwitchTarget', () => {
  it('leaves the folder alone when it already sits on the chosen branch', () => {
    expect(zotzCheckoutSwitchTarget('refs/heads/main', undefined)).toBeNull()
    expect(zotzCheckoutSwitchTarget('refs/heads/main', 'main')).toBeNull()
    expect(zotzCheckoutSwitchTarget('refs/heads/main', 'origin/main')).toBeNull()
  })

  it('switches to a local branch or tracks a remote one', () => {
    expect(zotzCheckoutSwitchTarget('refs/heads/main', 'feature/login')).toEqual({
      kind: 'local',
      name: 'feature/login'
    })
    expect(zotzCheckoutSwitchTarget('refs/heads/main', 'origin/release')).toEqual({
      kind: 'remote',
      name: 'origin/release'
    })
  })
})
