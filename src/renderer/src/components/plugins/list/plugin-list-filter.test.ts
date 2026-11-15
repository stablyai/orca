import { describe, expect, it } from 'vitest'
import { pluginFilterKinds } from './plugin-list-filter'

describe('pluginFilterKinds', () => {
  it('files interface translations apart from code languages', () => {
    expect([...pluginFilterKinds({ categories: ['language-packs'] })]).toEqual(['translations'])
    expect([...pluginFilterKinds({ categories: ['localization'] })]).toEqual(['translations'])
    expect([...pluginFilterKinds({ categories: ['syntaxes'] })]).toEqual(['languages'])
  })

  it('files an uncataloged interface language under translations', () => {
    const kinds = pluginFilterKinds({ categories: [], types: ['interface-language', 'syntax'] })
    expect([...kinds].sort()).toEqual(['languages', 'translations'])
  })
})
