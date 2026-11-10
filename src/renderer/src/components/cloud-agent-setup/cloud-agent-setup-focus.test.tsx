// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudAgentSetupView } from './CloudAgentSetupView'

const NONE = { claude: null, codex: null }

function keyInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="password"]')
  if (!input) {
    throw new Error('no key field')
  }
  return input
}
describe('CloudAgentSetupView Escape', () => {
  afterEach(cleanup)

  function renderView(onCancel = vi.fn()) {
    render(
      <CloudAgentSetupView
        readiness={NONE}
        canShare={false}
        initialOption="api-key"
        onSave={async () => null}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    )
    return onCancel
  }

  it('closes at once when nothing was typed', () => {
    const onCancel = renderView()
    fireEvent.keyDown(keyInput(), {
      key: 'Escape'
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('asks before discarding a typed key, and a second Escape discards', () => {
    const onCancel = renderView()
    const key = keyInput()
    fireEvent.change(key, { target: { value: 'sk-ant-api03-abc' } })
    fireEvent.keyDown(key, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByText('Discard the key you typed?')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep editing' }), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('drops the question once the key is cleared', () => {
    const onCancel = renderView()
    const key = keyInput()
    fireEvent.change(key, { target: { value: 'sk-ant-api03-abc' } })
    fireEvent.keyDown(key, { key: 'Escape' })
    fireEvent.change(key, { target: { value: '' } })
    expect(screen.queryByText('Discard the key you typed?')).toBeNull()
    fireEvent.keyDown(key, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Keep editing keeps the draft', () => {
    const onCancel = renderView()
    const key = keyInput()
    fireEvent.change(key, { target: { value: 'sk-ant-api03-abc' } })
    fireEvent.keyDown(key, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('Discard the key you typed?')).toBeNull()
    expect(keyInput().value).toBe('sk-ant-api03-abc')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
