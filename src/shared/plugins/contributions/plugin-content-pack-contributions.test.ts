import { expect, it } from 'vitest'
import { pluginKeybindingContributionSchema } from './plugin-content-pack-contributions'

it('requires the portable Plus spelling for the + key in plugin keybindings', () => {
  const parseKey = (key: string) =>
    pluginKeybindingContributionSchema.safeParse({ command: 'demo.run', key })
  expect(parseKey('Mod+Plus').data?.key).toBe('Mod+Plus')
  expect(parseKey('Mod+,').data?.key).toBe('Mod+Comma')
  expect(parseKey('Mod+K++').data?.key).toBe('Mod+K')
  for (const key of ['Mod++', 'Ctrl + Shift + +', 'Mod+++']) {
    expect(parseKey(key).error?.issues[0]?.message).toBe('write the + key as Plus, like Mod+Plus')
  }
})
