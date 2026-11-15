// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from '@/components/native-chat/messages/rows/NativeChatMessageRow'

afterEach(cleanup)

// What an answer can end with, right above its actions.
const ENDINGS: Record<string, NativeChatMessage['blocks']> = {
  paragraph: [{ type: 'text', text: 'Two items moved to done.' }],
  list: [{ type: 'text', text: 'Two items moved:\n\n- Share dialog\n- Release notes' }],
  code: [{ type: 'text', text: 'Run this:\n\n```sh\npnpm test\n```' }],
  images: [{ type: 'image-ref', url: 'https://example.com/shot.png' }]
}

/** Tailwind's spacing step (`3` in `mt-3`, `2.5` in `my-2.5`) for the given side. */
function spacing(element: Element, side: 'mt' | 'mb'): number {
  const prefixes = side === 'mt' ? ['mt', 'my', 'm'] : ['mb', 'my', 'm']
  const steps = [...element.classList].flatMap((token) => {
    const match = /^(m[tby]?)-(\d+(?:\.\d+)?)$/.exec(token)
    return match && prefixes.includes(match[1]!) ? [Number(match[2])] : []
  })
  return Math.max(0, ...steps)
}

function renderActions(blocks: NativeChatMessage['blocks']): HTMLElement {
  render(
    <TooltipProvider>
      <MessageRow
        message={{ id: 'answer', role: 'assistant', timestamp: 0, source: 'transcript', blocks }}
        // A turn's last row holds its actions, as the list marks it; an image-only answer needs it.
        endsResponse
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    </TooltipProvider>
  )
  const actions = screen.getByRole('button', { name: 'Scroll this message to top' }).parentElement
  expect(actions).not.toBeNull()
  return actions!
}

describe('the gap above an answer’s actions', () => {
  it('is the actions’ own, the same whatever the answer ends with', () => {
    const classes = Object.entries(ENDINGS).map(([ending, blocks]) => {
      const name = renderActions(blocks).className
      cleanup()
      return [ending, name] as const
    })
    const [, first] = classes[0]!
    expect(first.split(' ')).toContain('mt-3')
    for (const [ending, name] of classes) {
      expect({ ending, name }).toEqual({ ending, name: first })
    }
  })

  it('is at least as large as the margin of anything the answer can end with', () => {
    // The actions' margin collapses with the last block's, so a larger block margin would widen the
    // gap for that ending only.
    for (const blocks of Object.values(ENDINGS)) {
      const actions = renderActions(blocks)
      const own = spacing(actions, 'mt')
      let above = actions.previousElementSibling
      while (above) {
        expect(spacing(above, 'mb')).toBeLessThanOrEqual(own)
        above = above.lastElementChild
      }
      cleanup()
    }
  })
})
