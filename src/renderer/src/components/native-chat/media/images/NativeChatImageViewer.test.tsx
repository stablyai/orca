// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatImageViewer } from './NativeChatImageAttachments'

afterEach(cleanup)

const BLOCKS = ['before.png', 'after.png', 'diff.png'].map((name) => ({
  type: 'image-ref' as const,
  url: `https://example.invalid/${name}`,
  alt: name
}))

function Viewer({ blocks = BLOCKS }: { blocks?: typeof BLOCKS }): React.JSX.Element {
  const [index, setIndex] = useState<number | null>(0)
  return (
    <NativeChatImageViewer
      blocks={blocks}
      index={index}
      onIndexChange={setIndex}
      runtimeContext={null}
    />
  )
}

const shown = () => screen.getByRole('dialog').querySelector('img')?.getAttribute('alt')

it("steps through a message's images by the toolbar arrows and the arrow keys", () => {
  render(<Viewer />)
  expect(shown()).toBe('before.png')
  expect(screen.getByRole('button', { name: 'Previous image' }).hasAttribute('disabled')).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
  expect(shown()).toBe('after.png')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
  expect(shown()).toBe('diff.png')
  expect(screen.getByRole('button', { name: 'Next image' }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
  expect(shown()).toBe('after.png')

  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows no arrows for a lone image', () => {
  render(<Viewer blocks={BLOCKS.slice(0, 1)} />)
  expect(shown()).toBe('before.png')
  expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull()
})
