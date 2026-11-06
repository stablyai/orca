// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, it, expect, vi } from 'vitest'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { clearHostAgentMenuSettingsForTests } from '../../runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import {
  mountTextGenerationDialog,
  pickDialogAgent,
  pickDialogSaveTarget
} from './source-control/panel/source-control-action-dialog.test-fixture'

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
