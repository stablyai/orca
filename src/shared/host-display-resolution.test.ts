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
    ).toEqual({
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
    ).toEqual({ title: 'm4airs-Air', descriptorLine: 'macOS' })
  })

  it('labels whichever descriptor half an older host reported', () => {
    expect(resolveHostDisplay({ name: 'Desk', platform: 'linux' })).toEqual({
      title: 'Desk',
      descriptorLine: 'Linux'
    })
    expect(resolveHostDisplay({ name: 'Desk', machineName: 'build-box' })).toEqual({
      title: 'Desk',
      descriptorLine: 'build-box'
    })
    expect(resolveHostDisplay({ name: 'Desk' })).toEqual({
      title: 'Desk',
      descriptorLine: null
    })
  })

  it('normalizes blank inputs', () => {
    expect(resolveHostDisplay({ name: '  ', machineName: '  ' })).toEqual({
      title: 'Host',
      descriptorLine: null
    })
  })
})
