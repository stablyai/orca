import { describe, expect, it } from 'vitest'
import { wslSelectedAccounts } from './wsl-selected-account'

const SETTINGS = {
  claudeManagedAccounts: [
    { id: 'c1', email: 'work@acme.dev' },
    { id: 'c2', email: 'me@home.dev' }
  ],
  activeClaudeManagedAccountIdsByRuntime: { host: 'c2', wsl: { 'Ubuntu-24.04': 'c1' } },
  codexManagedAccounts: [{ id: 'x1', email: 'codex@acme.dev' }],
  activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { 'ubuntu-24.04': null } }
} as const

describe('wslSelectedAccounts', () => {
  it('names the account selected for that distro in Accounts, from settings only', () => {
    expect(wslSelectedAccounts(SETTINGS, 'ubuntu-24.04')).toEqual({
      claude: 'work@acme.dev',
      codex: null
    })
  })

  it('names nothing without a distro or a selection', () => {
    expect(wslSelectedAccounts(null, 'Ubuntu')).toEqual({ claude: null, codex: null })
  })
})
