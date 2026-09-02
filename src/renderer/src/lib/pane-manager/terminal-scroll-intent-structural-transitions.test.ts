import { describe, expect, it, vi } from 'vitest'
import {
  bindTerminalScrollIntentKey,
  captureTerminalStructuralScrollIntent,
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  restoreTerminalStructuralScrollIntent
} from './terminal-scroll-intent'

type BufferType = 'normal' | 'alternate'

function createTerminal(viewportY: number, baseY: number, type: BufferType = 'normal') {
  const terminal = {
    buffer: { active: { type, viewportY, baseY } },
    scrollToBottom: vi.fn(() => {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line
    })
  }
  return terminal
}

describe('terminal structural scroll-intent transitions', () => {
  it.each([
    {
      name: 'live pinned growth',
      storedKind: 'pinnedViewport' as const,
      live: { viewportY: 76, baseY: 120, type: 'normal' as const },
      expected: { kind: 'pinnedViewport', viewportY: 76, baseY: 120, bufferType: 'normal' }
    },
    {
      name: 'empty pinned remount',
      storedKind: 'pinnedViewport' as const,
      live: { viewportY: 0, baseY: 0, type: 'normal' as const },
      expected: { kind: 'pinnedViewport', viewportY: 76, baseY: 100, bufferType: 'normal' }
    },
    {
      name: 'shorter pinned remount',
      storedKind: 'pinnedViewport' as const,
      live: { viewportY: 20, baseY: 30, type: 'normal' as const },
      expected: { kind: 'pinnedViewport', viewportY: 76, baseY: 100, bufferType: 'normal' }
    },
    {
      name: 'alternate buffer entered from a normal-buffer pin',
      storedKind: 'pinnedViewport' as const,
      live: { viewportY: 0, baseY: 0, type: 'alternate' as const },
      expected: { kind: 'pinnedViewport', viewportY: 76, baseY: 100, bufferType: 'normal' }
    },
    {
      name: 'untracked return to bottom',
      storedKind: 'pinnedViewport' as const,
      live: { viewportY: 100, baseY: 100, type: 'normal' as const },
      expected: { kind: 'followOutput', viewportY: 100, baseY: 100, bufferType: 'normal' }
    },
    {
      name: 'empty follow-output remount',
      storedKind: 'followOutput' as const,
      live: { viewportY: 0, baseY: 0, type: 'normal' as const },
      expected: { kind: 'followOutput', viewportY: 0, baseY: 0, bufferType: 'normal' }
    }
  ])('captures the authoritative coordinates for $name', ({ storedKind, live, expected }) => {
    const key = `structural-${storedKind}-${live.type}-${live.viewportY}-${live.baseY}`
    const original = createTerminal(76, 100)
    bindTerminalScrollIntentKey(original, key)
    if (storedKind === 'pinnedViewport') {
      markTerminalPinnedViewport(original)
    } else {
      original.buffer.active.viewportY = original.buffer.active.baseY
      markTerminalFollowOutput(original)
    }

    const current = createTerminal(live.viewportY, live.baseY, live.type)
    bindTerminalScrollIntentKey(current, key)

    expect(captureTerminalStructuralScrollIntent(current)).toMatchObject(expected)
  })

  it('restores a durable remount pin by bottom offset without overwriting newer intent', () => {
    const original = createTerminal(76, 100)
    bindTerminalScrollIntentKey(original, 'structural-remount-revision')
    markTerminalPinnedViewport(original)
    const remounted = createTerminal(0, 0)
    bindTerminalScrollIntentKey(remounted, 'structural-remount-revision')
    const staleIntent = captureTerminalStructuralScrollIntent(remounted)

    remounted.buffer.active.viewportY = 200
    remounted.buffer.active.baseY = 200
    markTerminalFollowOutput(remounted)
    restoreTerminalStructuralScrollIntent(remounted, staleIntent, { restoreBy: 'bottomOffset' })

    expect(remounted.scrollToLine).not.toHaveBeenCalled()
    expect(remounted.buffer.active.viewportY).toBe(200)
  })

  it('keeps a normal-buffer pin dormant while replay restores an alternate buffer', () => {
    const original = createTerminal(76, 100)
    bindTerminalScrollIntentKey(original, 'structural-buffer-switch')
    markTerminalPinnedViewport(original)
    const remounted = createTerminal(0, 0, 'alternate')
    bindTerminalScrollIntentKey(remounted, 'structural-buffer-switch')
    const intent = captureTerminalStructuralScrollIntent(remounted)

    remounted.buffer.active.baseY = 40
    remounted.buffer.active.viewportY = 40
    restoreTerminalStructuralScrollIntent(remounted, intent, { restoreBy: 'bottomOffset' })
    expect(remounted.scrollToLine).not.toHaveBeenCalled()

    remounted.buffer.active.type = 'normal'
    remounted.buffer.active.baseY = 140
    remounted.buffer.active.viewportY = 140
    restoreTerminalStructuralScrollIntent(remounted, intent, { restoreBy: 'bottomOffset' })
    expect(remounted.scrollToLine).toHaveBeenLastCalledWith(116)
  })
})
