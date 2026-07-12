import { describe, it, expect } from 'vitest'
import { normalizeProjectDefaultShell, resolveDefaultShell } from './project-default-shell'

const wsl = { status: 'resolved', runtime: { kind: 'wsl', distro: 'Ubuntu' } } as never
const host = { status: 'resolved', runtime: { kind: 'windows-host' } } as never
const repair = { status: 'repair-required', repair: {} } as never

describe('normalizeProjectDefaultShell', () => {
  it('normalizes', () => {
    expect(normalizeProjectDefaultShell('x')).toBe('inherit')
    expect(normalizeProjectDefaultShell('cmd')).toBe('cmd')
  })
})

describe('resolveDefaultShell', () => {
  it('WSL runtime always wsl.exe, ignoring project/override', () => {
    expect(
      resolveDefaultShell({
        creationOverride: 'cmd.exe',
        projectDefaultShell: 'powershell',
        runtime: wsl
      })
    ).toBe('wsl.exe')
  })
  it('repair-required stays wsl.exe', () => {
    expect(
      resolveDefaultShell({
        creationOverride: 'cmd.exe',
        projectDefaultShell: 'cmd',
        runtime: repair
      })
    ).toBe('wsl.exe')
  })
  it('windows-host: creation override > project > global', () => {
    expect(
      resolveDefaultShell({
        creationOverride: 'cmd.exe',
        projectDefaultShell: 'powershell',
        runtime: host
      })
    ).toBe('cmd.exe')
    expect(resolveDefaultShell({ projectDefaultShell: 'powershell', runtime: host })).toBe(
      'powershell.exe'
    )
    expect(
      resolveDefaultShell({
        projectDefaultShell: 'inherit',
        runtime: host,
        globalDefaultShell: 'pwsh.exe'
      })
    ).toBe('pwsh.exe')
  })
  it('windows-host: project defaultShell of "wsl" is not honored, falls through to global', () => {
    expect(
      resolveDefaultShell({
        projectDefaultShell: 'wsl',
        runtime: host,
        globalDefaultShell: 'pwsh.exe'
      })
    ).toBe('pwsh.exe')
  })
})
