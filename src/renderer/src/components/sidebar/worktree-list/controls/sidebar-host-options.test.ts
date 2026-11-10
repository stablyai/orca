import { describe, expect, it } from 'vitest'
import { getSidebarHostHealthDotClass } from './sidebar-host-options'

describe('sidebar host options', () => {
  it('colors the host status dot by health', () => {
    expect(getSidebarHostHealthDotClass('local')).toBe('bg-status-success')
    expect(getSidebarHostHealthDotClass('available')).toBe('bg-status-success')
    expect(getSidebarHostHealthDotClass('connecting')).toBe('bg-status-warning')
    expect(getSidebarHostHealthDotClass('disconnected')).toBe('bg-muted-foreground/40')
    expect(getSidebarHostHealthDotClass('blocked')).toBe('bg-destructive')
    expect(getSidebarHostHealthDotClass('error')).toBe('bg-destructive')
  })
})
