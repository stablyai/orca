import { describe, expect, it } from 'vitest'
import { hermesProfileFromHome, hermesSetupCommand } from './hermes-setup-commands'

describe('Hermes setup commands', () => {
  it('checks the profile HERMES_HOME names, and never puts an unsafe name on the command line', () => {
    expect(hermesProfileFromHome('/Users/me/.hermes/profiles/orca')).toBe('orca')
    expect(hermesProfileFromHome('C:\\Users\\me\\AppData\\Local\\hermes\\profiles\\work-1\\')).toBe(
      'work-1'
    )
    expect(hermesProfileFromHome('/Users/me/.hermes')).toBeNull()
    expect(hermesProfileFromHome('/Users/me/.hermes/profiles/x; rm -rf ~')).toBeNull()
    expect(hermesSetupCommand('hermes', 'orca', 'acp-check')).toBe('hermes -p orca acp --check')
    expect(hermesSetupCommand('hermes', null, 'version')).toBe('hermes --version')
  })
})
