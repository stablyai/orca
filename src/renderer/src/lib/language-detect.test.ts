import { describe, expect, it } from 'vitest'
import { detectLanguage } from './language-detect'

describe('detectLanguage', () => {
  it('maps .vue files to the custom vue language id', () => {
    expect(detectLanguage('src/components/App.vue')).toBe('vue')
  })

  it('maps .svelte files to the custom svelte language id', () => {
    expect(detectLanguage('src/components/Widget.svelte')).toBe('svelte')
  })

  it('keeps .astro mapped to html until its grammar ships', () => {
    expect(detectLanguage('src/routes/index.astro')).toBe('html')
  })
})
