// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDiffHunkStageDecorator } from './useDiffHunkStageDecorator'
import type { DiffHunk } from '../../../../shared/git-hunk-patch'

type MoveArg = { target: { position?: { lineNumber: number } }; event?: unknown }
type Handlers = { move?: (e: MoveArg) => void; leave?: () => void; scroll?: () => void }

function makeEditor(): { editor: unknown; host: HTMLElement; handlers: Handlers } {
  const host = document.createElement('div')
  const handlers: Handlers = {}
  const editor = {
    getDomNode: () => host,
    getOption: () => 19,
    getTopForLineNumber: (ln: number) => ln * 19,
    getScrollTop: () => 0,
    onMouseMove: (cb: (e: MoveArg) => void) => ((handlers.move = cb), { dispose() {} }),
    onMouseLeave: (cb: () => void) => ((handlers.leave = cb), { dispose() {} }),
    onDidScrollChange: (cb: () => void) => ((handlers.scroll = cb), { dispose() {} })
  }
  return { editor, host, handlers }
}

// hunk 0 covers modified lines 1-3, hunk 1 covers lines 11-12.
const HUNKS: DiffHunk[] = [
  {
    index: 0,
    header: '@@ -1,2 +1,3 @@',
    lines: [],
    newStart: 1,
    newLineCount: 3,
    oldStart: 1,
    oldLineCount: 2
  },
  {
    index: 1,
    header: '@@ -10,1 +11,2 @@',
    lines: [],
    newStart: 11,
    newLineCount: 2,
    oldStart: 10,
    oldLineCount: 1
  }
]

function btn(host: HTMLElement): HTMLButtonElement {
  return host.querySelector('.orca-diff-hunk-stage-btn') as HTMLButtonElement
}

const roots: Root[] = []
function Probe(props: Parameters<typeof useDiffHunkStageDecorator>[0]): null {
  useDiffHunkStageDecorator(props)
  return null
}
async function render(props: Parameters<typeof useDiffHunkStageDecorator>[0]): Promise<void> {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => {
    root.render(<Probe {...props} />)
  })
}

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount())
  }
  roots.length = 0
})

describe('useDiffHunkStageDecorator', () => {
  it('reveals the pill on hover within a hunk and stages it on click', async () => {
    const { editor, host, handlers } = makeEditor()
    const onApplyHunk = vi.fn()
    await render({
      editor: editor as never,
      hunks: HUNKS,
      label: 'Stage hunk',
      disabled: false,
      onApplyHunk
    })

    act(() => handlers.move?.({ target: { position: { lineNumber: 12 } } }))
    expect(btn(host).style.display).not.toBe('none')
    expect(btn(host).textContent).toBe('Stage hunk')

    act(() => btn(host).dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onApplyHunk).toHaveBeenCalledWith(1)
  })

  it('hides the pill over lines outside any hunk', async () => {
    const { editor, host, handlers } = makeEditor()
    await render({
      editor: editor as never,
      hunks: HUNKS,
      label: 'Stage hunk',
      disabled: false,
      onApplyHunk: vi.fn()
    })
    act(() => handlers.move?.({ target: { position: { lineNumber: 2 } } }))
    expect(btn(host).style.display).not.toBe('none')
    act(() => handlers.move?.({ target: { position: { lineNumber: 6 } } }))
    expect(btn(host).style.display).toBe('none')
  })

  it('does not stage while disabled', async () => {
    const { editor, host, handlers } = makeEditor()
    const onApplyHunk = vi.fn()
    await render({
      editor: editor as never,
      hunks: HUNKS,
      label: 'Unstage hunk',
      disabled: true,
      onApplyHunk
    })
    act(() => handlers.move?.({ target: { position: { lineNumber: 2 } } }))
    expect(btn(host).disabled).toBe(true)
    act(() => btn(host).dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onApplyHunk).not.toHaveBeenCalled()
  })

  it('mounts no button anywhere without an editor', async () => {
    await render({
      editor: null,
      hunks: HUNKS,
      label: 'Stage hunk',
      disabled: false,
      onApplyHunk: vi.fn()
    })
    // The hook appends to editor.getDomNode(); with no editor it must touch nothing.
    expect(document.querySelector('.orca-diff-hunk-stage-btn')).toBeNull()
  })
})
