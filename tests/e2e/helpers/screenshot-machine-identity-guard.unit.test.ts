import { describe, expect, it } from 'vitest'
import { findMachineIdentityLeaks, type MachineIdentity } from './screenshot-machine-identity-guard'

const IDENTITY: MachineIdentity = {
  username: 'ada',
  hostname: 'Adas-Laptop.local',
  'short-hostname': 'Adas-Laptop',
  home: '/Users/ada'
}

describe('findMachineIdentityLeaks', () => {
  it.each([
    ['a neutral prompt and tmpdir path', '% ls /var/folders/xy/T/orca-e2e-repo-1', []],
    ['a stock zsh prompt', 'ada@Adas-Laptop checkout % ', ['username', 'short-hostname']],
    ['the full hostname in any case', 'ssh adas-laptop.LOCAL', ['hostname', 'short-hostname']],
    [
      'a home path',
      "'/Users/ada/src/orca/test-results/fake-claude/bin/claude'",
      ['username', 'home']
    ],
    ['the username only inside a longer word', 'Adamant readers', []]
  ])('reports %s', (_name, text, leaks) => {
    expect(findMachineIdentityLeaks(text, IDENTITY)).toEqual(leaks)
  })
})
