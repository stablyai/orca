import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/class-names'
import {
  menuIndicatorItemVariants,
  menuItemVariants,
  menuSeparatorVariants,
  menuSubTriggerVariants
} from './menu-item'

const classes = (value: string) => cn(value).split(/\s+/)

describe('menu row density', () => {
  it('gives default rows 26px (5 + 16 + 5) and compact rows 24px (4 + 16 + 4)', () => {
    for (const row of [
      (density: 'default' | 'compact') => menuItemVariants({ density, menu: 'dropdown' }),
      (density: 'default' | 'compact') => menuItemVariants({ density, menu: 'context' }),
      (density: 'default' | 'compact') => menuIndicatorItemVariants({ density }),
      (density: 'default' | 'compact') => menuSubTriggerVariants({ density })
    ]) {
      expect(classes(row('default'))).toEqual(expect.arrayContaining(['py-[5px]', 'leading-4']))
      expect(classes(row('compact'))).toEqual(expect.arrayContaining(['py-1', 'leading-4']))
      expect(classes(row('compact'))).not.toContain('py-[5px]')
    }
    expect(classes(menuSeparatorVariants({ density: 'compact' }))).toContain('my-[5px]')
  })

  it('keeps the dense launch row and the header chip at their own size in either density', () => {
    for (const density of ['default', 'compact'] as const) {
      expect(classes(menuItemVariants({ density, menu: 'dropdown' }))).toContain(
        'data-[variant=launch]:py-1'
      )
      const chip = classes(menuSubTriggerVariants({ density, variant: 'header-chip' }))
      expect(chip).toContain('py-0')
      expect(chip).not.toContain('py-1')
      expect(chip).not.toContain('py-[5px]')
    }
  })
})
