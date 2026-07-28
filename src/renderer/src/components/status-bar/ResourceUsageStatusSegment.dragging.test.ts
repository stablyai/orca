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

  it('keeps the translated position through the exit animation, then resets it', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    const cancelStart = source.indexOf('const cancelFloatingDrag = useCallback')
    const cancelEnd = source.indexOf('const resetFloatingPosition = useCallback', cancelStart)
    const cancel = source.slice(cancelStart, cancelEnd)
    const resetStart = source.indexOf('const resetFloatingPosition = useCallback')
    const resetEnd = source.indexOf('const setResourceManagerOpen = useCallback', resetStart)
    const reset = source.slice(resetStart, resetEnd)
    const closeStart = source.indexOf('const setResourceManagerOpen = useCallback')
    const exitStart = source.indexOf('const handleFloatingExitAnimationEnd = useCallback')
    const exitEnd = source.indexOf('useEffect(() => {', exitStart)
    const close = source.slice(closeStart, exitStart)
    const exit = source.slice(exitStart, exitEnd)

    expect(cancelStart).toBeGreaterThanOrEqual(0)
    expect(cancel).toContain('cancelAnimationFrame(floatingDragFrameRef.current)')
    expect(cancel).toContain('floatingDragFrameRef.current = null')
    expect(cancel).toContain('floatingDragRef.current = null')
    expect(cancel).toContain('pendingFloatingPositionRef.current = null')
    expect(cancel).toContain('setFloatingDragging(false)')

    expect(resetStart).toBeGreaterThanOrEqual(0)
    expect(reset).toContain('cancelFloatingDrag()')
    expect(reset).toContain('floatingPositionRef.current = null')
    expect(reset).toContain("'--resource-manager-x', '0px'")
    expect(reset).toContain("'--resource-manager-y', '0px'")
    expect(reset).toContain('setFloatingPosition(null)')

    expect(closeStart).toBeGreaterThanOrEqual(0)
    expect(close).not.toContain('resetFloatingPosition()')
    expect(close).toContain('cancelFloatingDrag()')
    expect(exitStart).toBeGreaterThanOrEqual(0)
    expect(exit).toContain("event.currentTarget.dataset.state !== 'closed'")
    expect(exit).toContain('resetFloatingPosition()')
    expect(source).toContain('onAnimationEnd={handleFloatingExitAnimationEnd}')
    expect(source).not.toContain('setOpen(false)')
    expect(source).toContain('setResourceManagerOpen(nextOpen)')
  })
})
