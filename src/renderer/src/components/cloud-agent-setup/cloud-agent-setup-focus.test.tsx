// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudAgentSetupView } from './CloudAgentSetupView'
import { VmBuildCloudAgentStepView } from './VmBuildCloudAgentStep'

const NONE = { claude: null, codex: null }
const actions = {
  onSave: async () => null,
  onDone: vi.fn(),
  onSignIn: vi.fn(),
  onCancelSignIn: vi.fn(),
  onLater: vi.fn()
}

function step(props: Partial<React.ComponentProps<typeof VmBuildCloudAgentStepView>> = {}) {
  return (
    <ol>
      <VmBuildCloudAgentStepView
        model={{ readiness: NONE, canShare: false }}
        actions={actions}
        {...props}
      />
      <li>
        <button type="button">next row</button>
      </li>
    </ol>
  )
}

describe('VmBuildCloudAgentStepView', () => {
  afterEach(cleanup)

  it('returns focus to Change after Cancel when agents were already ready', async () => {
    render(step({ model: { readiness: { claude: 'team', codex: 'team' }, canShare: false } }))
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change' }))
    )
  })

  it('keeps one status region across states so announcements survive the swap', () => {
    render(step())
    const region = screen.getByRole('status')
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe('Agent setup skipped')
  })

  it('keeps a handed-off row while it holds focus, then lets it go', async () => {
    const { rerender } = render(step({ initialMode: { kind: 'signIn' } }))
    const row = document.querySelector<HTMLElement>('[data-vm-build-cloud-agent]')
    row?.focus()
    rerender(step({ initialMode: { kind: 'signIn' }, handedOff: true }))
    expect(document.querySelector('[data-vm-build-cloud-agent]')).toBe(row)
    expect(document.activeElement).toBe(row)
    const next = screen.getByRole('button', { name: 'next row' })
    fireEvent.blur(row as HTMLElement, { relatedTarget: next })
    await waitFor(() => expect(document.querySelector('[data-vm-build-cloud-agent]')).toBeNull())
  })

  it('renders nothing once handed off when focus is elsewhere', () => {
    render(step({ initialMode: { kind: 'signIn' }, handedOff: true }))
    expect(document.querySelector('[data-vm-build-cloud-agent]')).toBeNull()
  })
})

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
    fireEvent.keyDown(document.querySelector('input[type="password"]') as Element, {
      key: 'Escape'
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('asks before discarding a typed key, and a second Escape discards', () => {
    const onCancel = renderView()
    const key = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'sk-ant-api03-abc' } })
    fireEvent.keyDown(key, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByText('Discard the key you typed?')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep editing' }), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Keep editing keeps the draft', () => {
    const onCancel = renderView()
    const key = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(key, { target: { value: 'sk-ant-api03-abc' } })
    fireEvent.keyDown(key, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByText('Discard the key you typed?')).toBeNull()
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe(
      'sk-ant-api03-abc'
    )
    expect(onCancel).not.toHaveBeenCalled()
  })
})
