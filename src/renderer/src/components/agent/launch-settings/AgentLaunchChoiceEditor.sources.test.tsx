// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLaunchChoiceEditor } from './AgentLaunchChoiceEditor'
import { cliModelMenuScope } from '@/runtime/native-chat/model-catalogs/model-menu-cli-catalog'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { cliResult } from '../agent-launch-picker-sources.test-fixture'
const mocks = vi.hoisted(() => ({ discover: vi.fn() }))
vi.mock('@/runtime/source-control/git/runtime-git-generation-client', () => ({
  discoverRuntimeCommitMessageModels: mocks.discover
}))
vi.mock('./AgentChoiceMenu', () => ({
  AgentChoiceMenu: (props: {
    label: string
    value: string
    choices: { value: string; label: string }[]
    onChange: (value: string) => void
    onOpenChange?: (open: boolean) => void
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      onFocus={() => props.onOpenChange?.(true)}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  )
}))
afterEach(() => {
  cleanup()
  resetHostModelCatalogSnapshotsForTests()
  mocks.discover.mockReset()
})
it('saves a model-only terminal edit with an explicit effort clear through the Settings writer', async () => {
  mocks.discover.mockResolvedValue(cliResult)
  const save = vi.fn().mockResolvedValue(undefined)
  const source = {
    source: 'cli' as const,
    coherentCatalog: true,
    scope: cliModelMenuScope(
      { target: { kind: 'local' }, worktreeId: undefined, worktreePath: '' },
      'antigravity',
      'agy'
    )
  }
  const choices = { options: { effort: 'high' } }
  const editor = render(
    <AgentLaunchChoiceEditor
      agent="antigravity"
      label="Antigravity"
      choices={choices}
      userArgs=""
      permission={undefined}
      showArguments={false}
      catalogSource={source}
      save={save}
    />
  )
  expect(mocks.discover).not.toHaveBeenCalled()
  fireEvent.focus(screen.getByRole('combobox', { name: 'Model' }))
  await screen.findByRole('option', { name: 'Gemini 3.8 Flash (Low)' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
    target: { value: 'gemini-3.8-flash-low' }
  })
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      { model: 'gemini-3.8-flash-low', options: { effort: null } },
      ''
    )
  )
  expect(choices).toEqual({ options: { effort: 'high' } })
  editor.rerender(
    <AgentLaunchChoiceEditor
      agent="antigravity"
      label="Antigravity"
      choices={{ model: 'gemini-3.8-flash-low' }}
      userArgs=""
      permission={undefined}
      showArguments={false}
      catalogSource={source}
      save={save}
    />
  )
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Thinking' })).toBeNull())
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
    target: { value: '__agent_default__' }
  })
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ model: null }, ''))
})
