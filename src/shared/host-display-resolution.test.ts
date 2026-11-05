import { describe, expect, it } from 'vitest'
import { resolveHostDisplay } from './host-display-resolution'

describe('resolveHostDisplay', () => {
  it('titles with the caller label and shows a disagreeing machine name beneath it', () => {
    expect(
      resolveHostDisplay({
        name: 'Windows-Low Spec',
        machineName: 'm4airs-Air',
        platform: 'darwin'
      })
    ).toMatchObject({
      title: 'Windows-Low Spec',
      descriptorLine: 'macOS · m4airs-Air'
    })
  })

  it('never titles with the machine name, whatever the label state', () => {
    // The title-fallback bug class: a late descriptor must not be able to retitle a row.
    for (const name of ['Host 2', 'Desk']) {
      expect(
        resolveHostDisplay({ name, machineName: 'm4airs-Air', platform: 'darwin' }).title
      ).toBe(name)
    }
  })

  it('keeps the OS visible when the shown name is the machine name', () => {
    expect(
      resolveHostDisplay({
        name: 'm4airs-Air',
        machineName: 'm4airs-Air',
        platform: 'darwin'
      })
    ).toMatchObject({ title: 'm4airs-Air', descriptorLine: 'macOS' })
  })

  it('labels whichever descriptor half an older host reported', () => {
    expect(resolveHostDisplay({ name: 'Desk', platform: 'linux' })).toMatchObject({
      title: 'Desk',
      descriptorLine: 'Linux'
    })
    expect(resolveHostDisplay({ name: 'Desk', machineName: 'build-box' })).toMatchObject({
      title: 'Desk',
      descriptorLine: 'build-box'
    })
    expect(resolveHostDisplay({ name: 'Desk' })).toMatchObject({
      title: 'Desk',
      descriptorLine: null
    })
  })

  it('normalizes blank inputs', () => {
    expect(resolveHostDisplay({ name: '  ', machineName: '  ' })).toMatchObject({
      title: 'Host',
      descriptorLine: null
    })
  })

  it('describes the machine as model or kind plus OS, falling back to the OS for older desktops', () => {
    const display = (
      machine: Parameters<typeof resolveHostDisplay>[0]['machine'],
      platform?: NodeJS.Platform
    ) => resolveHostDisplay({ name: 'Desk', machine, platform })
    expect(display({ kind: 'laptop', model: 'MacBook Pro' }, 'darwin')).toMatchObject({
      machineKind: 'laptop',
      machineLine: 'MacBook Pro · macOS'
    })
    expect(display({ kind: 'server', model: null }, 'linux')).toMatchObject({
      machineKind: 'server',
      machineLine: 'Server · Linux'
    })
    expect(display({ kind: 'desktop', model: '  ' }, 'win32').machineLine).toBe('Desktop · Windows')
    expect(display(null, 'darwin')).toMatchObject({ machineKind: null, machineLine: 'macOS' })
    expect(display(undefined)).toMatchObject({ machineKind: null, machineLine: null })
  })
})
