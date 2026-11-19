// @vitest-environment happy-dom
import { Activity } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import MermaidBlock from './MermaidBlock'

// Mirrors mermaid.render(): it removes any document element that already has the requested ID.
vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async (id: string) => {
      document.getElementById(id)?.remove()
      return {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg>`
      }
    }
  }
}))
// happy-dom's DOMPurify drops the <svg> element, which is where Mermaid puts the render ID.
vi.mock('./mermaid-sanitize', () => ({ sanitizeMermaidSvg: (svg: string) => svg }))

it('keeps a chat diagram visible after its Activity is hidden and revealed', async () => {
  const onExpand = (): void => {}
  const pane = (visible: boolean) => (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      {/* Markdown preview headings render github-slugger IDs such as a repeated "Mermaid" heading's. */}
      <h3 id="mermaid-1">Mermaid</h3>
      <MermaidBlock content="flowchart LR; A-->B" isDark={false} onExpand={onExpand} />
    </Activity>
  )
  const view = render(pane(true))
  await waitFor(() => expect(view.container.querySelector('.mermaid-block svg')).not.toBeNull())

  act(() => view.rerender(pane(false)))
  act(() => view.rerender(pane(true)))

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(view.container.querySelector('.mermaid-block svg')).not.toBeNull()
  expect(view.container.querySelector('#mermaid-1')).not.toBeNull()
})
