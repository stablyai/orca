// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  AgentCatalogMutation,
  AgentCatalogMutationResult
} from '../../../../shared/agent-catalog-snapshot'
import { TooltipProvider } from '../ui/tooltip'
import { BuiltInLaunchSettingsDialog } from './BuiltInLaunchSettingsDialog'

const mutateMock = vi.hoisted(() =>
  vi.fn<(mutation: AgentCatalogMutation) => Promise<AgentCatalogMutationResult>>()
)
const settingsMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))

vi.mock('@/lib/agent-catalog-authoring', () => ({
  mutateAgentCatalog: (mutation: AgentCatalogMutation) => mutateMock(mutation)
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: settingsMock.value }) }
}))

const OK_RESULT: AgentCatalogMutationResult = { ok: true, revision: 4, snapshot: {} as never }

beforeEach(() => {
  mutateMock.mockReset()
  mutateMock.mockResolvedValue(OK_RESULT)
  settingsMock.value = {
    agentCmdOverrides: { codex: '/opt/codex' },
    agentDefaultArgs: { codex: '--model gpt-5' },
    agentDefaultEnv: { codex: { CODEX_HOME: '/x' } }
  }
})

afterEach(() => cleanup())

function renderDialog(): { onSaved: ReturnType<typeof vi.fn> } {
  const onSaved = vi.fn()
  render(
    <BuiltInLaunchSettingsDialog open agent="codex" onOpenChange={vi.fn()} onSaved={onSaved} />
  )
  return { onSaved }
}

describe('BuiltInLaunchSettingsDialog', () => {
  it('seeds command, args, and env from the current settings overrides', () => {
    renderDialog()
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('/opt/codex')
    expect((screen.getByLabelText('Arguments') as HTMLTextAreaElement).value).toBe('--model gpt-5')
    expect((screen.getByLabelText('Variable name') as HTMLInputElement).value).toBe('CODEX_HOME')
  })

  it('submits an update-built-in mutation with the edited launch fields', async () => {
    const { onSaved } = renderDialog()
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/usr/bin/codex' } })
    fireEvent.change(screen.getByLabelText('Arguments'), {
      target: { value: '--model gpt-5-mini' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock).toHaveBeenCalledWith({
      kind: 'update-built-in',
      agent: 'codex',
      changes: {
        commandOverride: '/usr/bin/codex',
        args: '--model gpt-5-mini',
        env: { CODEX_HOME: '/x' }
      }
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(4))
  })

  it('accepts a multi-token wrapper command without a validation block', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'mise exec -- codex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock.mock.calls[0][0]).toMatchObject({
      kind: 'update-built-in',
      changes: { commandOverride: 'mise exec -- codex' }
    })
  })

  it('clears the command override to no-override when Reset is used', async () => {
    renderDialog()
    // The command field renders before the args field, so its Reset is the first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset' })[0])
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1))
    expect(mutateMock.mock.calls[0][0]).toMatchObject({ changes: { commandOverride: null } })
  })

  it('shows the codex session-source home control and commits it on blur', () => {
    const onSave = vi.fn()
    render(
      <TooltipProvider>
        <BuiltInLaunchSettingsDialog
          open
          agent="codex"
          codexSessionSourceHome={{ runtimeLabel: '~/.codex', value: '/old/codex', onSave }}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />
      </TooltipProvider>
    )
    const input = screen.getByPlaceholderText('~/.codex') as HTMLInputElement
    expect(input.value).toBe('/old/codex')
    // Commit-on-blur persists independently of the dialog's Save button.
    fireEvent.change(input, { target: { value: '/new/codex' } })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledWith('/new/codex')
  })

  it('hides the codex session-source control for a non-codex harness', () => {
    render(
      <TooltipProvider>
        <BuiltInLaunchSettingsDialog
          open
          agent="claude"
          codexSessionSourceHome={{ runtimeLabel: '~/.codex', value: '', onSave: vi.fn() }}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />
      </TooltipProvider>
    )
    expect(screen.queryByText('Codex home to import from')).toBeNull()
  })
})
