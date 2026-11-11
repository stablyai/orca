// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useGitGraphViewport } from './use-git-graph-viewport'

it('keeps visible geometry through hidden panes, fractional scroll, resize, append, shrink, reveal and remount', async () => {
  let height = 0
  let resize = () => {}
  let reveal = (_index: number) => {}
  const owner = { scrollOffset: 0 }
  const getOffset = () => owner.scrollOffset
  const setOffset = (value: number) => {
    owner.scrollOffset = value
  }
  const host = document.createElement('div')
  document.body.append(host)
  let root = createRoot(host)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const child = this.firstElementChild
    return Number.parseFloat(child instanceof HTMLElement ? child.style.height : '0') + 48
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    }
  )
  function Pane({ count }: { count: number }) {
    const viewport = useGitGraphViewport(count, getOffset, setOffset)
    reveal = viewport.reveal
    return (
      <div ref={viewport.scroll} onScroll={viewport.onScroll} data-end={viewport.lastVisible}>
        <div style={{ height: viewport.height }}>
          {viewport.items.map((row) => (
            <span key={row.index} data-row={row.index} style={{ top: row.start }} />
          ))}
        </div>
      </div>
    )
  }
  const render = (count: number) => act(async () => root.render(<Pane count={count} />))
  const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-row]'))
  const scroll = () => host.querySelector<HTMLElement>(':scope > div')!
  try {
    await render(100)
    expect(rows()).toHaveLength(0)
    height = 48
    await act(async () => resize())
    expect(scroll().dataset.end).toBe('1')
    expect(rows().at(-1)?.dataset.row).toBe('13')
    await act(async () => {
      scroll().scrollTop = 24.5
      scroll().dispatchEvent(new Event('scroll'))
    })
    expect(scroll().dataset.end).toBe('3')
    expect(rows().at(-1)?.style.top).toBe('360px')
    await act(async () => {
      scroll().scrollTop = 2352
      scroll().dispatchEvent(new Event('scroll'))
    })
    await render(150)
    expect(scroll().dataset.end).toBe('99')
    expect(rows().at(-1)?.dataset.row).toBe('111')
    await act(async () => reveal(149))
    expect(scroll().scrollTop).toBe(3600)
    await act(async () => reveal(20))
    expect(scroll().scrollTop).toBe(480)
    await act(async () => reveal(21))
    expect(scroll().scrollTop).toBe(480)
    await render(10)
    expect(rows().at(-1)?.dataset.row).toBe('9')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render(100)
    expect(scroll().scrollTop).toBe(480)
    height = 240
    await act(async () => resize())
    expect(scroll().dataset.end).toBe('29')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
