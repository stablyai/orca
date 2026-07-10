import { describe, expect, it } from 'vitest'
import { createWikiHistory } from './wiki-panel-navigation'

describe('createWikiHistory', () => {
  it('pushes, goes back, and resets to root', () => {
    const h = createWikiHistory('Home.md')
    expect(h.current()).toBe('Home.md')
    h.push('Бизнес-логика/F.md')
    expect(h.current()).toBe('Бизнес-логика/F.md')
    expect(h.canGoBack()).toBe(true)
    h.back()
    expect(h.current()).toBe('Home.md')
    expect(h.canGoBack()).toBe(false)
    h.push('a.md')
    h.home()
    expect(h.current()).toBe('Home.md')
  })
})
