// @vitest-environment happy-dom

import path from 'node:path'
import React, { type ReactNode, useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings, Repo, TuiAgent } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  onOpenChange: vi.fn(),
  onSaveAgentDefault: vi.fn(),
  onLaunched: vi.fn(),
  onStart: vi.fn(),
  planSourceControlAgentActionLaunch: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) =>
    React.createElement('div', { 'data-agent-value': value ?? '' })
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', { 'data-dialog-open': 'true' }, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children, value }: { children?: ReactNode; value: string }) =>
    React.createElement('div', { 'data-select-item': value }, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))
vi.mock('../source-control/SourceControlActionVariableChips', () => ({
  SourceControlActionVariableChips: () => React.createElement('div')
}))
vi.mock('@/lib/source-control-agent-action-plan', () => ({
  planSourceControlAgentActionLaunch: mocks.planSourceControlAgentActionLaunch
}))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))
import { useAppStore, type AppState } from '@/store'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
let container: HTMLDivElement
let root: Root
let initialState: AppState
function settingsWithGlobalRecipe(
  recipe: SourceControlActionRecipe | null = {
    agentId: 'codex',
    commandInputTemplate: '{basePrompt}',
    agentArgs: ''
  },
  disabledTuiAgents: GlobalSettings['disabledTuiAgents'] = []
): GlobalSettings {
  const base = getDefaultSettings(path.resolve('tmp'))
  return {
    ...base,
    defaultTuiAgent: 'codex',
    disabledTuiAgents,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      customAgentCommand: '',
      actions: recipe ? { resolveConflicts: recipe } : {}
    }
  }
}
function repoWithSavedRecipe(): Repo {
  return {
    id: 'repo-1',
    sourceControlAi: {
      enabled: true,
      actionOverrides: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: ''
        }
      }
    }
  } as Repo
}
function resetStore(settings: GlobalSettings, repos: Repo[] = []): void {
  useAppStore.setState(
    {
      ...initialState,
      settings,
      repos,
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents
    },
    true
  )
}
function renderControlledDialog(
  overrides: Partial<React.ComponentProps<typeof SourceControlAgentActionDialog>> = {},
  options: { strictMode?: boolean } = {}
): void {
  function Harness(): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return (
      <SourceControlAgentActionDialog
        open={open}
        onOpenChange={(nextOpen) => {
          mocks.onOpenChange(nextOpen)
          setOpen(nextOpen)
        }}
        actionId="resolveConflicts"
        title="Launch agent"
        description="Review the launch recipe before starting."
        baseCommandInput="Resolve conflicts."
        savedCommandInputTemplate="{basePrompt}"
        savedAgentArgs=""
        launchSource="source_control_recovery"
        savedAgentId="codex"
        onSaveAgentDefault={mocks.onSaveAgentDefault}
        onLaunched={mocks.onLaunched}
        onStart={mocks.onStart}
        {...overrides}
      />
    )
  }

  act(() => {
    root.render(
      options.strictMode ? (
        <React.StrictMode>
          <Harness />
        </React.StrictMode>
      ) : (
        <Harness />
      )
    )
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
describe('SourceControlAgentActionDialog', () => {
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    initialState = useAppStore.getState()
    vi.clearAllMocks()
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.onStart.mockResolvedValue(true)
    mocks.planSourceControlAgentActionLaunch.mockReturnValue({
      ok: true,
      summary: 'Ready to launch.',
      commandLabel: 'codex',
      caveat: 'The prompt will be submitted after the agent is ready.'
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    resetStore(settingsWithGlobalRecipe())
  })
  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    useAppStore.setState(initialState, true)
  })
  it('hides the dialog and auto-starts once when the saved global launch recipe matches', async () => {
    renderControlledDialog()
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false))
    expect(mocks.ensureDetectedAgents).toHaveBeenCalledTimes(1)
    expect(mocks.onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Resolve conflicts.',
      agentArgs: ''
    })
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Launch agent')
  })
  it('hides the dialog and auto-starts once when the saved repo launch recipe matches', async () => {
    resetStore(
      settingsWithGlobalRecipe({ agentId: 'claude', commandInputTemplate: '{basePrompt}' }),
      [repoWithSavedRecipe()]
    )
    renderControlledDialog({ repoId: 'repo-1' })
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false))
    expect(mocks.ensureDetectedAgents).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Launch agent')
  })
  it('renders the form and does not auto-start when the saved launch recipe mismatches', async () => {
    resetStore(
      settingsWithGlobalRecipe({ agentId: 'claude', commandInputTemplate: '{basePrompt}' })
    )
    renderControlledDialog()
    await vi.waitFor(() => expect(mocks.ensureDetectedAgents).toHaveBeenCalledTimes(1))
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Launch agent')
    expect(container.textContent).toContain('Save & start agent')
  })
  it('reveals the form with status copy when the saved agent is unavailable', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue([])
    resetStore(settingsWithGlobalRecipe())
    renderControlledDialog()
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() =>
      expect(container.textContent?.toLowerCase()).toContain('not enabled or was not detected')
    )
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Launch agent')
  })
  it('reveals the dialog and remains open when auto-start fails', async () => {
    mocks.onStart.mockResolvedValue(false)
    renderControlledDialog()
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('keeps prompt editing available when async auto-start delivery fails', async () => {
    mocks.onStart.mockImplementation(async () => {
      await Promise.resolve()
      return false
    })
    renderControlledDialog({
      baseCommandInput: 'Resolve queued comments.',
      savedCommandInputTemplate: '{basePrompt}'
    })
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))

    expect(container.querySelector('textarea')?.value).toContain('{basePrompt}')
    expect(container.textContent).toContain('Start agent')
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('does not auto-start when a saved receipt appears after the dialog is already open', async () => {
    let setSavedAgentId: (agent: TuiAgent | null) => void = () => {}

    function Harness(): React.JSX.Element {
      const [savedAgentId, setNextSavedAgentId] = useState<TuiAgent | null>(null)
      setSavedAgentId = setNextSavedAgentId
      return (
        <SourceControlAgentActionDialog
          open
          onOpenChange={mocks.onOpenChange}
          actionId="resolveConflicts"
          title="Launch agent"
          description="Review the launch recipe before starting."
          baseCommandInput="Resolve conflicts."
          savedCommandInputTemplate="{basePrompt}"
          savedAgentArgs=""
          launchSource="source_control_recovery"
          savedAgentId={savedAgentId}
          onSaveAgentDefault={mocks.onSaveAgentDefault}
          onLaunched={mocks.onLaunched}
          onStart={mocks.onStart}
        />
      )
    }
    act(() => {
      root.render(<Harness />)
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))
    act(() => {
      setSavedAgentId('codex')
    })
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Launch agent')
  })
  it('does not double-start during StrictMode effect replay', async () => {
    renderControlledDialog({}, { strictMode: true })

    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await flushEffects()
    expect(mocks.onStart).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
  })
})
