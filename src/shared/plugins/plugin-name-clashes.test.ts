import { describe, expect, it } from 'vitest'
import { pluginNameClashKeys } from './plugin-name-clashes'

const item = (key: string, name: string, official = false) => ({
  key,
  name,
  publisher: key.split('.')[0],
  official
})

describe('pluginNameClashKeys', () => {
  it('marks only the non-official side of a clash', () => {
    expect(
      pluginNameClashKeys([
        item('stablyai.orca-catppuccin-theme', 'Catppuccin for Orca', true),
        item('vale-c.catppuccin', 'Catppuccin for Orca')
      ])
    ).toEqual(new Set(['vale-c.catppuccin']))
  })

  it('marks every side when none is official, ignoring case and spacing', () => {
    expect(
      pluginNameClashKeys([
        item('acme.mocha', 'Mocha'),
        item('beta.mocha', ' mocha '),
        item('c.x', 'X')
      ])
    ).toEqual(new Set(['acme.mocha', 'beta.mocha']))
  })

  it('leaves unique names and official clashes plain', () => {
    expect(
      pluginNameClashKeys([
        item('stablyai.a', 'Same', true),
        item('stablyai.b', 'Same', true),
        item('acme.c', 'Other')
      ]).size
    ).toBe(0)
  })

  it('does not count one item listed twice as a clash', () => {
    expect(pluginNameClashKeys([item('acme.x', 'X'), item('acme.x', 'X')]).size).toBe(0)
  })
})
