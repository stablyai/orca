import { describe, expect, it, vi } from 'vitest'
import { describeTerminalTabIntoPaneRefusal } from './terminal-tab-into-pane-reasons'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

describe('describeTerminalTabIntoPaneRefusal', () => {
  it('says a pane with no terminal has none, not that it is still starting', () => {
    expect(describeTerminalTabIntoPaneRefusal('no_terminal')).toBe('No running terminal')
  })

  it.each(['pending_spawn', 'launch_pending', 'startup_pending'] as const)(
    'keeps "Still starting" for %s',
    (reason) => {
      expect(describeTerminalTabIntoPaneRefusal(reason)).toBe('Still starting')
    }
  )
})
