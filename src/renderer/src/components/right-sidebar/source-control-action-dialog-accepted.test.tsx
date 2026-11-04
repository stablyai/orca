// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, it, expect, vi } from 'vitest'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { clearHostAgentMenuSettingsForTests } from '../../runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import type { RunSourceControlAgentActionStartArgs } from './runSourceControlAgentActionStart'
import {
  mountSourceDialog,
  mountTextGenerationDialog,
  pickDialogAgent,
  pickDialogSaveTarget
} from './source-control-action-dialog.test-fixture'

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearHostAgentMenuSettingsForTests()
  useAppStore.setState(initialState, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

it('accepts the Customize agent-only choice through Save defaults and Generate with exact authored inputs', async () => {
  const f = mountTextGenerationDialog()
  const agentArgs = '  --model "sonnet"  --append-system-prompt \'Keep spacing\'  '
  const commandInputTemplate = '{basePrompt}\n\nKeep "{branch}" unchanged.  '
  fireEvent.change(screen.getByRole('textbox', { name: 'CLI arguments' }), {
    target: { value: agentArgs }
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Command template' }), {
    target: { value: commandInputTemplate }
  })
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  const claude = await screen.findByRole('menuitem', { name: /^Claude/ })
  expect(screen.queryByRole('menuitem', { name: 'Custom command' })).toBeNull()
  fireEvent.click(claude)
  await pickDialogSaveTarget('Save for this repository only')
  const accepted = {
    agentId: 'claude',
    model: 'sonnet',
    thinkingLevel: 'low',
    agentArgs,
    commandInputTemplate
  }
  fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }))
  await waitFor(() =>
    expect(f.onSaveDefaults).toHaveBeenCalledWith({ type: 'repo', repoId: f.repo.id }, accepted)
  )
  expect(f.onGenerate).not.toHaveBeenCalled()
  expect(f.onOpenChange).not.toHaveBeenCalled()

  const generate = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Generate commit message'
  })
  await waitFor(() => expect(generate.disabled).toBe(false))
  fireEvent.click(generate)
  expect(f.onGenerate).toHaveBeenCalledExactlyOnceWith(accepted)
  expect(f.onOpenChange).toHaveBeenCalledWith(false)
})

it('keeps a configured Custom command selectable in Customize and generates with its authored inputs', async () => {
  const f = mountTextGenerationDialog('my-commit-writer --prompt {prompt}')
  const agentArgs = '  --label "release notes"  '
  const commandInputTemplate = '{basePrompt}\n\nPrefer ticket IDs.'
  fireEvent.change(screen.getByRole('textbox', { name: 'CLI arguments' }), {
    target: { value: agentArgs }
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Command template' }), {
    target: { value: commandInputTemplate }
  })
  await pickDialogAgent('Custom command', true)
  fireEvent.click(screen.getByRole('button', { name: 'Generate commit message' }))
  expect(f.onGenerate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentId: 'custom',
      model: '',
      customAgentCommand: 'my-commit-writer --prompt {prompt}',
      agentArgs,
      commandInputTemplate
    })
  )
  expect(f.onSaveDefaults).not.toHaveBeenCalled()
  expect(f.onOpenChange).toHaveBeenCalledWith(false)
})

it.each(['Close', 'Escape', 'outside'] as const)(
  'hides accepted work through %s while Cancel and duplicate Start stay disabled',
  async (dismiss) => {
    const completion = Promise.withResolvers<boolean>()
    const onStart = vi.fn<NonNullable<RunSourceControlAgentActionStartArgs['onStart']>>((args) => {
      args.onCreateAccepted?.()
      return completion.promise
    })
    const f = mountSourceDialog({ agentId: 'codex' }, { agentId: 'codex' }, undefined, onStart)
    const start = await screen.findByRole<HTMLButtonElement>('button', {
      name: /^(Save & start agent|Start agent)$/
    })
    await waitFor(() => expect(start.disabled).toBe(false))
    fireEvent.click(start)
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
    expect(start.disabled).toBe(true)
    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledOnce()
    if (dismiss === 'Close') {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    } else if (dismiss === 'Escape') {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    } else {
      // Radix installs its document pointer listener after the opening effect.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const overlay = document.querySelector('[data-slot="dialog-overlay"]')
      if (!overlay) {
        throw new Error('Missing dialog overlay')
      }
      fireEvent.pointerDown(overlay, { button: 0, pointerType: 'mouse', isPrimary: true })
      fireEvent.click(overlay)
    }
    await waitFor(() => expect(f.props.onOpenChange).toHaveBeenCalledWith(false))
    const oldSignal = onStart.mock.calls[0][0].signal
    expect(oldSignal?.aborted).toBe(true)
    f.view.rerender(<SourceControlAgentActionDialog {...f.props} open={false} />)
    const closeCount = vi.mocked(f.props.onOpenChange).mock.calls.length
    const successor = Promise.withResolvers<boolean>()
    if (dismiss === 'Close') {
      onStart.mockImplementationOnce((args) => {
        args.onCreateAccepted?.()
        return successor.promise
      })
      f.view.rerender(<SourceControlAgentActionDialog {...f.props} />)
      const nextStart = await screen.findByRole<HTMLButtonElement>('button', {
        name: /^(Save & start agent|Start agent)$/
      })
      await waitFor(() => expect(nextStart.disabled).toBe(false))
      fireEvent.click(nextStart)
      await waitFor(() => expect(onStart).toHaveBeenCalledTimes(2))
    }
    await act(async () => completion.resolve(true))
    expect(f.props.onOpenChange).toHaveBeenCalledTimes(closeCount)
    if (dismiss === 'Close') {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true)
      const currentStart = screen.getByRole<HTMLButtonElement>('button', {
        name: /^(Save & start agent|Start agent)$/
      })
      expect(currentStart.disabled).toBe(true)
      fireEvent.click(currentStart)
      expect(onStart).toHaveBeenCalledTimes(2)
      await act(async () => successor.resolve(true))
      expect(f.props.onOpenChange).toHaveBeenCalledTimes(closeCount + 1)
    }
  }
)
