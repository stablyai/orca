import { describe, expect, it } from 'vitest'
import { wslDistroMenuRows } from './wsl-distro-menu-rows'

describe('wslDistroMenuRows', () => {
  it('leaves out distros that are already hosts and keeps WSL 1 listed but disabled', () => {
    const rows = wslDistroMenuRows([
      { name: 'Ubuntu', state: 'running', version: 2, environmentId: 'wsl:ubuntu' },
      { name: 'Debian', state: 'stopped', version: 2, environmentId: null },
      { name: 'Legacy', state: 'stopped', version: 1, environmentId: null }
    ])
    expect(rows.map(({ distro, disabled }) => [distro.name, disabled])).toEqual([
      ['Debian', false],
      ['Legacy', true]
    ])
  })
})
