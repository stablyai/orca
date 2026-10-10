import { describe, expect, it, vi } from 'vitest'
import { positionStableNodeViewUpdate } from './position-stable-node-view-update'

type UpdateArgs = Parameters<typeof positionStableNodeViewUpdate>[0]

function updateArgs(overrides: Partial<UpdateArgs> = {}): UpdateArgs {
  const node = { type: 'codeBlock' }
  const decorations = [] as unknown as UpdateArgs['newDecorations']
  const innerDecorations = { inner: true } as unknown as UpdateArgs['innerDecorations']
  return {
    oldNode: node,
    newNode: node,
    oldDecorations: decorations,
    newDecorations: decorations,
    oldInnerDecorations: innerDecorations,
    innerDecorations,
    updateProps: vi.fn(),
    ...overrides
  } as UpdateArgs
}

describe('positionStableNodeViewUpdate', () => {
  it('skips the re-render when only the document position moved', () => {
    const args = updateArgs()

    expect(positionStableNodeViewUpdate(args)).toBe(true)
    expect(args.updateProps).not.toHaveBeenCalled()
  })

  it('re-renders when the node itself changed', () => {
    const args = updateArgs({ newNode: { type: 'codeBlock' } as unknown as UpdateArgs['newNode'] })

    expect(positionStableNodeViewUpdate(args)).toBe(true)
    expect(args.updateProps).toHaveBeenCalledOnce()
  })

  it('re-renders when decorations changed', () => {
    // Why: search highlights and review annotations arrive as decorations — dropping
    // those updates would leave a code block visually stale.
    const args = updateArgs({ newDecorations: [] as unknown as UpdateArgs['newDecorations'] })

    expect(positionStableNodeViewUpdate(args)).toBe(true)
    expect(args.updateProps).toHaveBeenCalledOnce()
  })

  it('re-renders when inner decorations changed', () => {
    const args = updateArgs({
      innerDecorations: { inner: false } as unknown as UpdateArgs['innerDecorations']
    })

    expect(positionStableNodeViewUpdate(args)).toBe(true)
    expect(args.updateProps).toHaveBeenCalledOnce()
  })
})
