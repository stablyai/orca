// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-launch'
import { WorkerRoleProfileEditor } from './WorkerRoleProfileEditor'

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), error: '' }))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
    { id: 'gemini', label: 'Gemini' }
  ],
  getAgentLabel: (id: string) => id
}))
vi.mock('./use-worker-role-model-catalog', () => ({
  useWorkerRoleModelCatalog: () => {
    const catalog = getAgentSessionOptionLaunchCatalog('codex')
    return { ...catalog, catalog, refresh: mocks.refresh, error: mocks.error || null }
  }
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.error = ''
})
const props = {
  role: 'implementation',
  profile: { agent: 'codex' },
  disabled: false,
  disabledAgents: ['claude'],
  detectedIds: ['claude', 'codex'] as const,
  structuredFast: true,
  onChange: vi.fn()
}

describe('worker role profile choices', () => {
  it('offers enabled detected agents rather than every registered provider', () => {
    render(<WorkerRoleProfileEditor {...props} />)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Agent' }), { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Codex' })).toBeDefined()
    expect(screen.queryByRole('option', { name: 'Claude' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Gemini' })).toBeNull()
  })
  it('refreshes the current host model catalog when its model selector opens', () => {
    render(<WorkerRoleProfileEditor {...props} />)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
  it('keeps long retrieval diagnostics collapsed behind a quiet status and accessible retry', () => {
    mocks.error = 'Host connection closed: socket timeout and transport diagnostics. '.repeat(40)
    render(<WorkerRoleProfileEditor {...props} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Could not load models.')
    expect(status.className).toContain('text-muted-foreground')
    expect(screen.queryByRole('alert')).toBeNull()
    const details = screen.getByText(mocks.error.trim()).closest('details')
    expect(details?.open).toBe(false)
    expect(details?.querySelector('summary')?.textContent).toBe('Details')
    expect(screen.getByRole('combobox', { name: 'Model' }).getAttribute('aria-describedby')).toBe(
      status.id
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
  it('retains a saved unavailable agent explicitly without offering unrelated providers', () => {
    const onChange = vi.fn()
    render(<WorkerRoleProfileEditor {...props} profile={{ agent: 'gemini' }} onChange={onChange} />)
    expect(screen.getByRole('combobox', { name: 'Agent' }).textContent).toContain(
      'Gemini · Unavailable'
    )
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Agent' }), { key: 'ArrowDown' })
    expect(
      screen.getByRole('option', { name: 'Gemini · Unavailable' }).getAttribute('aria-disabled')
    ).toBe('true')
    expect(screen.getByRole('option', { name: 'Codex' })).toBeDefined()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps missing model and effort IDs visible, then resets only the chosen effort override', () => {
    const onChange = vi.fn()
    render(
      <WorkerRoleProfileEditor
        {...props}
        profile={{
          agent: 'codex',
          model: 'custom-model',
          effort: 'custom-effort',
          fastMode: false
        }}
        onChange={onChange}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toBe(
      'custom-model · Not listed'
    )
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' }).textContent).toBe(
      'custom-effort · Not listed'
    )
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Reasoning effort' }), {
      key: 'ArrowDown'
    })
    fireEvent.click(screen.getByRole('option', { name: 'Agent default' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      agent: 'codex',
      model: 'custom-model',
      fastMode: false
    })
  })

  it('resets model preferences to the real agent default without a synthetic model ID', () => {
    const onChange = vi.fn()
    render(
      <WorkerRoleProfileEditor
        {...props}
        profile={{ agent: 'codex', model: 'custom-model', effort: 'high', fastMode: false }}
        onChange={onChange}
      />
    )
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('option', { name: 'Agent default' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ agent: 'codex' })
  })

  it('does not infer agent availability before detection or Fast support from the native launch route', () => {
    const view = render(
      <WorkerRoleProfileEditor {...props} profile={undefined} detectedIds={null} />
    )
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Agent' }), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    view.unmount()
    render(
      <WorkerRoleProfileEditor {...props} profile={{ agent: 'codex', model: 'custom-model' }} />
    )
    expect(screen.getByRole('combobox', { name: 'Fast' }).hasAttribute('disabled')).toBe(true)
  })
})
