import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_PATH = resolve(__dirname, 'ResourceUsageStatusSegment.tsx')

describe('ResourceUsageStatusSegment dragging', () => {
  it('uses the full header as the drag surface without stealing button interactions', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const headerStart = source.indexOf('role="group"')
    const headerEnd = source.indexOf('{daemonUnreachable &&', headerStart)
    const header = source.slice(headerStart, headerEnd)

    expect(headerStart).toBeGreaterThanOrEqual(0)
    expect(header).toContain('onPointerDown={handleFloatingDragStart}')
    expect(header).toContain('onKeyDown={handleFloatingDragKeyDown}')
    expect(header).toContain("floatingDragging ? 'cursor-grabbing' : 'cursor-grab'")
    expect(source).not.toContain('GripHorizontal')
    expect(source).toContain("event.target.closest('button')")
    expect(source).toContain('event.target !== event.currentTarget')
  })

  it('clears every transient drag value before a close can be reopened', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const resetStart = source.indexOf('const resetFloatingPosition = useCallback')
    const resetEnd = source.indexOf('const setResourceManagerOpen = useCallback', resetStart)
    const reset = source.slice(resetStart, resetEnd)

    expect(resetStart).toBeGreaterThanOrEqual(0)
    expect(reset).toContain('cancelAnimationFrame(floatingDragFrameRef.current)')
    expect(reset).toContain('floatingDragFrameRef.current = null')
    expect(reset).toContain('floatingDragRef.current = null')
    expect(reset).toContain('pendingFloatingPositionRef.current = null')
    expect(reset).toContain('floatingPositionRef.current = null')
    expect(reset).toContain("'--resource-manager-x', '0px'")
    expect(reset).toContain("'--resource-manager-y', '0px'")
    expect(reset).toContain('setFloatingDragging(false)')
    expect(reset).toContain('setFloatingPosition(null)')

    // Why: outside-click, Escape, navigation, and the close button must all use
    // the same reset path or a later drag can inherit stale pointer coordinates.
    expect(source).not.toContain('setOpen(false)')
    expect(source).toContain('setResourceManagerOpen(nextOpen)')
  })
})
