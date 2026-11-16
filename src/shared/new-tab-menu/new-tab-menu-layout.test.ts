import { describe, expect, it } from 'vitest'
import { arrangeNewTabMenuItems, buildNewTabMenuLayout } from './new-tab-menu-layout'

const ids = (items: { id: string }[]) => items.map((item) => item.id)

describe('arrangeNewTabMenuItems', () => {
  const items = [
    { id: 'terminal', locked: true },
    { id: 'browser' },
    { id: 'markdown' },
    { id: 'plugin-file:excalidraw' },
    { id: 'mobile-emulator' }
  ]

  it('applies the saved order, places unseen items after their default neighbor, and never hides locked items', () => {
    const arranged = arrangeNewTabMenuItems(items, {
      order: ['mobile-emulator', 'markdown', 'terminal', 'browser'],
      hidden: ['browser', 'terminal']
    })
    expect(ids(arranged.visible)).toEqual([
      'mobile-emulator',
      'markdown',
      'plugin-file:excalidraw',
      'terminal'
    ])
    expect(ids(arranged.hidden)).toEqual(['browser'])
  })
})

describe('buildNewTabMenuLayout', () => {
  it('keeps unavailable items so they return where the user left them', () => {
    expect(
      buildNewTabMenuLayout(['terminal', 'markdown'], ['browser'], {
        order: ['terminal', 'mobile-emulator', 'browser', 'markdown'],
        hidden: ['mobile-emulator', 'browser']
      })
    ).toEqual({
      order: ['terminal', 'markdown', 'browser', 'mobile-emulator'],
      hidden: ['browser', 'mobile-emulator']
    })
  })
})
