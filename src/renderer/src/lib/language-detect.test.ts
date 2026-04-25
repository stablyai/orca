import { describe, expect, it } from 'vitest'
import { detectLanguage } from './language-detect'

describe('detectLanguage', () => {
  it('maps .vue files to the custom vue language id', () => {
    expect(detectLanguage('src/components/App.vue')).toBe('vue')
  })

  it('keeps .astro and .svelte mapped to html until their grammars ship', () => {
    expect(detectLanguage('src/routes/index.astro')).toBe('html')
    expect(detectLanguage('src/components/Widget.svelte')).toBe('html')
  })
})
