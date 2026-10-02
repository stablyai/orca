// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useExclusiveSessionControlMenu } from './agent-session-controls-support'

function Control({ name }: { name: string }): React.JSX.Element {
  const menu = useExclusiveSessionControlMenu()
  return (
    <button data-open={menu.open} onClick={() => menu.setOpen(true)}>
      {name}
    </button>
  )
}

afterEach(cleanup)

describe('agent session control menu', () => {
  it('keeps only the last-opened control menu open', () => {
    render(
      <>
        <Control name="Codex" />
        <Control name="Claude" />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(screen.getByRole('button', { name: 'Codex' }).dataset.open).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
    expect(screen.getByRole('button', { name: 'Codex' }).dataset.open).toBe('false')
    expect(screen.getByRole('button', { name: 'Claude' }).dataset.open).toBe('true')
  })
})
