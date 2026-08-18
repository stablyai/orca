import { describe, expect, it } from 'vitest'
import { resolveDialogContentClassName } from './dialog-content-class'

describe('resolveDialogContentClassName', () => {
  it('applies the default sm:max-w-lg cap when the caller passes no className', () => {
    const cls = resolveDialogContentClassName()
    expect(cls).toContain('sm:max-w-lg')
    expect(cls).toContain('max-w-[calc(100%-2rem)]')
  })

  it('keeps the default cap when the caller className has no max-width', () => {
    const cls = resolveDialogContentClassName('gap-0 p-0')
    expect(cls).toContain('sm:max-w-lg')
  })

  it('lets a bare max-w override win at every breakpoint by dropping the default', () => {
    const cls = resolveDialogContentClassName('max-w-md')
    expect(cls).toContain('max-w-md')
    // The bug: without dropping the sm:-scoped default, it out-specifies the
    // caller's bare max-w at >=sm and the modal stays 32rem wide.
    expect(cls).not.toContain('sm:max-w-lg')
  })

  it('honors a custom pixel max-width', () => {
    const cls = resolveDialogContentClassName('max-w-[360px]')
    expect(cls).toContain('max-w-[360px]')
    expect(cls).not.toContain('sm:max-w-lg')
  })

  it('keeps an sm:-scoped override and drops the redundant default', () => {
    const cls = resolveDialogContentClassName('sm:max-w-2xl')
    expect(cls).toContain('sm:max-w-2xl')
    expect(cls).not.toContain('sm:max-w-lg')
  })

  it('keeps the default below a later responsive override', () => {
    const cls = resolveDialogContentClassName('md:max-w-2xl')
    expect(cls).toContain('sm:max-w-lg')
    expect(cls).toContain('md:max-w-2xl')
  })

  it('does not treat a descendant max-width as a dialog width override', () => {
    const cls = resolveDialogContentClassName('[&_pre]:max-w-full')
    expect(cls).toContain('sm:max-w-lg')
    expect(cls).toContain('[&_pre]:max-w-full')
  })

  it('preserves an intentionally uncapped (max-w-none) dialog', () => {
    const cls = resolveDialogContentClassName('max-w-none sm:max-w-none')
    expect(cls).toContain('max-w-none')
    expect(cls).toContain('sm:max-w-none')
    expect(cls).not.toContain('sm:max-w-lg')
  })

  it('respects an important max-width override', () => {
    const cls = resolveDialogContentClassName('!max-w-[360px]')
    expect(cls).toContain('!max-w-[360px]')
    expect(cls).not.toContain('sm:max-w-lg')
  })

  it('respects Tailwind v4 suffix-important max-width overrides', () => {
    const cls = resolveDialogContentClassName('max-w-[360px]!')
    expect(cls).toContain('max-w-[360px]!')
    expect(cls).not.toContain('sm:max-w-lg')
  })

  it('appends caller layout classes after the base', () => {
    const cls = resolveDialogContentClassName('gap-4 p-0 sm:max-w-[520px]')
    expect(cls).toContain('gap-4')
    expect(cls).toContain('p-0')
    expect(cls).toContain('sm:max-w-[520px]')
  })
})
