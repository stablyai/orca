// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NativeChatMediaViewer } from './NativeChatMediaViewer'
import { nominateNativeChatMediaViewerTile } from './use-native-chat-media-viewer-focus'

const SRC =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/%3E'

// Each step waits for what it leads to: the viewer open with focus in it, the next image shown,
// then the viewer gone and focus moved (Radix moves focus on a zero-delay timer).
const openWithFocus = () =>
  vi.waitFor(() => {
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true)
  })
const showing = (index: number) =>
  vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`${index + 1} / 3`)
  )

function MessageImages({
  handOff
}: {
  handOff?: { current: (at: number) => void }
}): React.JSX.Element {
  const [index, setIndex] = useState<number | null>(null)
  const group = useRef<HTMLDivElement>(null)
  const paths = ['/a.png', '/b.png', '/c.png']
  if (handOff) {
    // As the chat's image set hands an image over: it has closed, so focus is on the page.
    handOff.current = (at) => {
      nominateNativeChatMediaViewerTile(group.current, at)
      setIndex(at)
    }
  }
  return (
    <div ref={group}>
      {paths.map((path, at) => (
        <div key={path}>
          <button type="button" data-tile={at} onClick={() => setIndex(at)}>
            {path}
          </button>
        </div>
      ))}
      <NativeChatMediaViewer
        open={index !== null}
        onOpenChange={(open) => !open && setIndex(null)}
        src={SRC}
        title={index === null ? '' : paths[index]}
        source={{ path: index === null ? '/none.png' : paths[index] }}
        opener={group}
        annotatable={false}
        onPrevious={index !== null && index > 0 ? () => setIndex(index - 1) : null}
        onNext={index !== null && index < 2 ? () => setIndex(index + 1) : null}
        position={index === null ? undefined : { index, count: 3 }}
      />
    </div>
  )
}

it('Esc after stepping returns focus to the tile that opened the viewer', async () => {
  const view = render(<MessageImages />)
  const tile = view.container.querySelector<HTMLButtonElement>('[data-tile="0"]')!
  tile.focus()
  act(() => {
    tile.click()
  })
  await openWithFocus()
  const dialog = document.querySelector('[role="dialog"]')!
  act(() => {
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
  })
  await showing(1)
  await openWithFocus()
  act(() => {
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' })
  })
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(tile))
})

it('Esc after stepping returns focus to the tile of an image the chat’s image set handed over', async () => {
  const handOff = { current: (_at: number) => {} }
  const view = render(<MessageImages handOff={handOff} />)
  const tile = view.container.querySelector<HTMLButtonElement>('[data-tile="1"]')!
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
  act(() => handOff.current(1))
  await openWithFocus()
  const dialog = document.querySelector('[role="dialog"]')!
  act(() => {
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
  })
  await showing(2)
  await openWithFocus()
  act(() => {
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' })
  })
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(tile))
})
