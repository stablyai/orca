// @vitest-environment happy-dom
import { entry, host, root, onUse } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent, getByText, isInaccessible, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import * as shell from '../../../../shared/tui-agent-startup-shell'
import { fetchCodexModelCatalogListing } from '../../lib/codex-model-catalog-reader-test-fixture'
import {
  agentPickerDraft,
  agentPickerChoiceSeeds,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

it('shows visible no-match feedback for a nonempty model query', async () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={{
            ...entry,
            terminal: { model: 'opus', permissionMode: 'ask' },
            catalog: {
              origin: 'probe',
              fetchedAt: 1,
              models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [] }]
            }
          }}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
  fireEvent.change(host.querySelector('input[aria-label="Search models"]')!, {
    target: { value: 'zzzzzz' }
  })
  await waitFor(() => {
    const message = getByText(host, 'No models match your search.')
    expect(isInaccessible(message)).toBe(false)
  })
})

it('shows a raw Arguments value in the shared Permissions menu; removing its chip selects own and preserves other text', () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={entry} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const permission = () =>
    host.querySelector<HTMLButtonElement>('button[aria-label$=" permissions"]')
  expect(permission()?.disabled).toBe(false)
  expect(permission()?.textContent).toContain('plan')
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value).toBe(
    '--add-dir docs'
  )
  act(() =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Remove --permission-mode plan"]')
      ?.click()
  )
  expect(permission()?.disabled).toBe(false)
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value).toBe(
    '--add-dir docs'
  )
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch terminal')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ surface: 'terminal', arguments: '--add-dir docs' })
  )
  expect(entry.arguments).toBe('--permission-mode plan --add-dir docs')
  expect(host.textContent).not.toContain('Reset to default')
  expect(host.textContent).toContain('Only applies to terminal (CLI) launches')
})

it('leaves chat Permissions enabled even with launch-owned raw CLI permission text', () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={entry}
          initial={{ ...agentPickerDraft(entry, 'chat'), arguments: '--permission-mode plan' }}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label$=" permissions"]')?.disabled
  ).toBe(false)
  expect(host.querySelector('button[aria-label="Remove --permission-mode plan"]')).not.toBeNull()
})

it('shows remembered chat defaults without turning displayed values into launch intent', () => {
  const chat: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    defaultSurface: 'chat',
    arguments: '--add-dir docs',
    structured: { model: 'astra', options: { effort: 'low' }, permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
      ]
    }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={chat} onUse={onUse} />
      </TooltipProvider>
    )
  )
  expect(host.querySelector('[role="radio"][data-state="on"]')?.textContent).toBe('Low')
  expect(host.querySelector('button[aria-label$=" permissions"]')?.textContent).toBe(
    'Ask for approval'
  )
  expect(host.textContent).not.toMatch(/Agents? defaults?|Reset to default/)
  expect(host.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('Astra')
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith({
    agent: 'codex',
    surface: 'chat',
    choices: {},
    arguments: undefined
  })
})

it('keeps pending defaults disabled, selects resolved values without overrides, and enables settled unselected models', () => {
  const pending: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    defaultSurface: 'chat',
    arguments: undefined,
    structured: {},
    defaultsPending: true,
    structuredDefaultsPending: true
  }
  const render = (value: AgentPickerEntry) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={value} onUse={onUse} />
        </TooltipProvider>
      )
    )
  render(pending)
  fireEvent.click(host.querySelector('button[aria-label="Toggle Arguments"]')!)
  expect(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Launch chat')
      ?.disabled
  ).toBe(false)
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.disabled).toBe(
    true
  )
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label$=" permissions"]')?.disabled
  ).toBe(true)
  expect(host.querySelector('[cmdk-item][data-current="true"]')).toBeNull()
  expect(
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.disabled
  ).toBe(true)
  render({
    ...pending,
    defaultsPending: false,
    structuredDefaultsPending: true,
    arguments: '--host-only'
  })
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.disabled).toBe(
    true
  )
  expect(
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.disabled
  ).toBe(false)
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value).toBe(
    '--host-only'
  )
  const settled: AgentPickerEntry = {
    ...pending,
    defaultsPending: false,
    structuredDefaultsPending: false,
    structured: { permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      models: [
        {
          id: 'host-model',
          label: 'Host model',
          isDefault: true,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
  }
  render(settled)
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.disabled).toBe(
    false
  )
  expect(host.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('Host model')
  expect(host.querySelector('[role="radio"][data-state="on"]')?.textContent).toBe('Low')
  expect(host.querySelector('button[aria-label$=" permissions"]')?.textContent).toBe(
    'Ask for approval'
  )
  expect(host.textContent).not.toMatch(/Agents? defaults?|Reset to default/)
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ choices: {}, arguments: undefined })
  )

  render({ ...settled, catalog: { origin: 'unknown' }, structured: { permissionMode: 'ask' } })
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')?.disabled).toBe(
    false
  )
  expect(host.querySelector('[cmdk-item][data-current="true"]')).toBeNull()
  expect(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Launch chat')
      ?.disabled
  ).toBe(false)
})

it('launches explicit model and effort picks when settled defaults have neither selected', () => {
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    defaultSurface: 'chat',
    arguments: undefined,
    structured: { permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: false,
      models: [
        {
          id: 'host-model',
          label: 'Host model',
          isDefault: false,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={own} onUse={onUse} />
      </TooltipProvider>
    )
  )
  expect(host.querySelector('[cmdk-item][data-current="true"]')).toBeNull()
  expect(host.querySelector('[role="radio"][data-state="on"]')).toBeNull()
  fireEvent.click(host.querySelector('[cmdk-item][data-value="host-model"]')!)
  expect(host.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('Host model')
  expect(host.querySelector('[role="radio"][data-state="on"]')).toBeNull()
  fireEvent.click(
    [...host.querySelectorAll('[role="radio"]')].find((radio) => radio.textContent === 'High')!
  )
  expect(host.querySelector('[role="radio"][data-state="on"]')?.textContent).toBe('High')
  fireEvent.click(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Launch chat')!
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      surface: 'chat',
      choices: { model: 'host-model', options: { effort: 'high' } }
    })
  )
  expect(agentPickerLaunchInputs(onUse.mock.calls[0][0], own).sessionOptions).toMatchObject({
    model: 'host-model',
    effort: 'high'
  })
  const footer = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Launch chat'
  )!.parentElement!
  expect(footer.textContent).toBe('Launch terminalLaunch chat')
})

it('returns to concrete default model, effort and permission values by selecting them directly', () => {
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    defaultSurface: 'chat',
    arguments: undefined,
    structured: { model: 'astra', options: { effort: 'low' }, permissionMode: 'ask' },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'astra',
          label: 'Astra',
          isDefault: true,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'other',
          label: 'Other',
          isDefault: false,
          defaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={own} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const model = (name: string) =>
    act(() =>
      [...host.querySelectorAll<HTMLElement>('[cmdk-item]')]
        .find((row) => row.textContent === name)
        ?.click()
    )
  model('Other')
  model('Astra')
  const select = (_label: string, value: string) => {
    fireEvent.keyDown(host.querySelector('button[aria-label$=" permissions"]')!, {
      key: 'ArrowDown'
    })
    fireEvent.click(
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((row) =>
        row.textContent?.startsWith(value)
      )!
    )
  }
  fireEvent.click(
    [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (row) => row.textContent === 'High'
    )!
  )
  fireEvent.click(
    [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (row) => row.textContent === 'Low'
    )!
  )
  select('Permissions', 'Full access')
  select('Permissions', 'Ask')
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      choices: { model: 'astra', options: { effort: 'low' }, permissionMode: 'ask' }
    })
  )
  expect(host.textContent).not.toMatch(/Agents? defaults?|Reset to default/)
})

it('searches current and supplied legacy models, keeps unknown explicit choices, and hides CLI Arguments for chat-only entries', () => {
  const catalog = {
    origin: 'probe' as const,
    fetchedAt: 1,
    models: [
      { id: 'current-model', label: 'Current model', isDefault: true, efforts: [] },
      {
        id: 'retired',
        label: 'Retired model',
        isDefault: false,
        efforts: [],
        isLegacy: true as const
      }
    ]
  }
  const chat: AgentPickerEntry = { ...entry, surfaces: ['chat'], defaultSurface: 'chat', catalog }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={chat}
          initial={{ ...agentPickerDraft(chat), choices: { model: 'private-model' } }}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
  expect(host.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
  expect(host.textContent).not.toContain('Only applies to terminal (CLI) launches')
  expect(host.querySelector('[cmdk-item][data-current="true"]')?.textContent).toBe('private-model')
  expect(host.textContent).toContain('Legacy models')
  expect(host.textContent).not.toContain('Retired model')
  const search = host.querySelector('input[aria-label="Search models"]')!
  fireEvent.change(search, { target: { value: 'Retired' } })
  expect(host.textContent).toContain('Retired model')
  act(() =>
    [...host.querySelectorAll<HTMLElement>('[cmdk-item]')]
      .find((row) => row.textContent === 'Retired model')
      ?.click()
  )
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch chat')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ choices: { model: 'retired' } })
  )
})

it.each(['chat', 'terminal'] as const)(
  'uses the %s default exactly once from Enter in CLI Arguments, keeping CLI changes out of Chat intent',
  (surface) => {
    const own = { ...entry, defaultSurface: surface }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={own}
            initial={{
              ...agentPickerDraft(own),
              choices: { model: 'opus', permissionMode: 'ask' }
            }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
    if (surface === 'chat') {
      fireEvent.click(host.querySelector('button[aria-label="Toggle Arguments"]')!)
    }
    const input = host.querySelector('textarea[aria-label="Arguments"]')!
    fireEvent.change(input, { target: { value: '--model haiku --dangerously-skip-permissions' } })
    for (const way of ['chat', 'terminal'] as const) {
      onUse.mockClear()
      act(() =>
        [...host.querySelectorAll('button')]
          .find(
            (button) => button.textContent === (way === 'chat' ? 'Launch chat' : 'Launch terminal')
          )
          ?.click()
      )
      expect(onUse).toHaveBeenCalledOnce()
      const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
      if (way === 'chat') {
        expect(launch).toEqual({ sessionOptions: { model: 'opus', permissionMode: 'full-access' } })
      } else {
        expect(launch.agentArgs).toContain('--dangerously-skip-permissions')
      }
    }
    onUse.mockClear()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUse).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        surface,
        choices: { model: 'opus', permissionMode: 'full-access' }
      })
    )
  }
)

it.each(['chat', 'terminal'] as const)(
  'reuses the Arguments editor inside its %s-default disclosure, with permission badge in the input frame',
  (surface) => {
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={{ ...entry, defaultSurface: surface }} onUse={onUse} />
        </TooltipProvider>
      )
    )
    const disclosure = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle Arguments"]'
    )!
    expect(disclosure.getAttribute('aria-expanded')).toBe(String(surface === 'terminal'))
    if (surface === 'chat') {
      expect(host.querySelector('textarea')).toBeNull()
      fireEvent.click(disclosure)
    }
    const text = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')!
    const chip = host.querySelector(
      surface === 'chat'
        ? 'button[aria-label="Remove --permission-mode default"]'
        : 'button[aria-label="Remove --permission-mode plan"]'
    )!
    expect(text.parentElement?.contains(chip)).toBe(true)
    expect(text.value).toBe('--add-dir docs')
    expect(host.textContent).not.toContain('Reset')
    expect(host.textContent).not.toContain('Default from Agents settings')
    fireEvent.click(disclosure)
    expect(host.querySelector('textarea')).toBeNull()
  }
)

it('keeps uncertain permission text literal instead of offering a badge that removes the whole Arguments field', () => {
  const raw = '--unknown-option value --permission-mode auto --add-dir docs'
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={{ ...entry, arguments: raw }} onUse={onUse} />
      </TooltipProvider>
    )
  )
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value).toBe(
    raw
  )
  expect(host.querySelector('button[aria-label^="Remove --unknown-option"]')).toBeNull()
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch terminal')
      ?.click()
  )
  expect(onUse).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ arguments: undefined, choices: {} })
  )
})

it('uses the shared permission menu without its inheritance row and couples raw, selected and removed flags in both directions', () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={entry} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const permission = () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Claude permissions"]')!
  expect(permission().textContent).toBe('plan')
  fireEvent.keyDown(permission(), { key: 'ArrowDown' })
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  expect(items.some((item) => item.textContent?.includes('Same as all agents'))).toBe(false)
  expect(items.some((item) => item.textContent === 'plan')).toBe(true)
  fireEvent.click(items.find((item) => item.textContent?.startsWith('Full access'))!)
  expect(
    host.querySelector('button[aria-label="Remove --dangerously-skip-permissions"]')
  ).not.toBeNull()
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')!
  expect(input.value).toBe('--add-dir docs')
  fireEvent.change(input, {
    target: { value: '--permission-mode acceptEdits --add-dir "keep spaces"' }
  })
  expect(permission().textContent).toBe('Accept edits')
  expect(input.value).toBe('--add-dir "keep spaces"')
  for (const way of ['Launch chat', 'Launch terminal']) {
    onUse.mockClear()
    fireEvent.click(
      [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
    )
    expect(onUse).toHaveBeenCalledOnce()
    const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], entry)
    expect(launch.sessionOptions?.permissionMode).toBe('accept-edits')
    if (way === 'Launch terminal') {
      expect(launch.agentArgs).toContain('--permission-mode acceptEdits')
      expect(launch.agentArgs).toContain('keep spaces')
      expect(launch.agentArgs).not.toContain('skip-permissions')
    }
  }
  fireEvent.click(host.querySelector('button[aria-label="Remove --permission-mode acceptEdits"]')!)
  expect(permission().textContent).toContain("Claude's own settings")
  expect(input.value).toBe('--add-dir "keep spaces"')
})

it.each(['chat', 'terminal'] as const)(
  'couples Claude Fast and its in-box Args badge for a %s default, both footers and Enter',
  (surface) => {
    const own: AgentPickerEntry = {
      ...entry,
      defaultSurface: surface,
      terminal: { model: 'opus', permissionMode: 'ask' },
      structured: { model: 'opus', permissionMode: 'ask', options: { fastMode: 'false' } },
      arguments: '--settings \'{"theme":"dark"}\' --add-dir docs',
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          { id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true }
        ]
      }
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={own} onUse={onUse} />
        </TooltipProvider>
      )
    )
    if (surface === 'chat') {
      fireEvent.click(host.querySelector('button[aria-label="Toggle Arguments"]')!)
    }
    const fast = host.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(fast.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(fast)
    expect(fast.getAttribute('aria-checked')).toBe('true')
    const chip = host.querySelector<HTMLButtonElement>("button[aria-label*='Remove --settings']")!
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')!
    expect(input.parentElement?.contains(chip)).toBe(true)
    expect(input.value).toContain('"theme":"dark"')
    for (const way of ['Launch chat', 'Launch terminal']) {
      onUse.mockClear()
      fireEvent.click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
      )
      const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
      expect(launch.sessionOptions?.fastMode).toBe('true')
      if (way === 'Launch terminal') {
        expect(launch.agentArgs).toContain('"fastMode":true')
        expect(launch.agentArgs).toContain('"theme":"dark"')
      }
    }
    fireEvent.click(chip)
    expect(fast.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(input, {
      target: { value: '--settings \'{"fastMode":true,"theme":"light"}\' --add-dir src' }
    })
    expect(fast.getAttribute('aria-checked')).toBe('true')
    onUse.mockClear()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUse).toHaveBeenCalledOnce()
    expect(onUse.mock.calls[0][0].surface).toBe(surface)
    expect(agentPickerLaunchInputs(onUse.mock.calls[0][0], own).sessionOptions?.fastMode).toBe(
      'true'
    )
  }
)

it.each([
  { surface: 'chat', model: 'host-private' },
  { surface: 'terminal', model: 'host-private' },
  { surface: 'terminal', model: 'sonnet' },
  { surface: 'terminal', model: 'haiku' }
] as const)(
  'keeps saved Fast Args removable for $model with a $surface default',
  ({ surface, model }) => {
    const args = `--model ${model} --settings '{"fastMode":true,"theme":"light"}' --add-dir docs`
    const own: AgentPickerEntry = {
      ...entry,
      defaultSurface: surface,
      ...agentPickerChoiceSeeds('claude', {
        agentPermissionDefault: 'own',
        agentDefaultArgs: { claude: args }
      })
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={own} onUse={onUse} />
        </TooltipProvider>
      )
    )
    if (surface === 'chat') {
      fireEvent.click(host.querySelector('button[aria-label="Toggle Arguments"]')!)
    }
    const chip = host.querySelector<HTMLButtonElement>('button[aria-label*="Remove --settings"]')
    expect(chip).not.toBeNull()
    const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')!
    expect(input.parentElement?.contains(chip)).toBe(true)
    expect(input.value).toContain(`--model ${model}`)
    expect(input.value).toContain('"theme":"light"')
    expect(input.value).toContain('--add-dir docs')
    for (const way of ['Launch chat', 'Launch terminal']) {
      onUse.mockClear()
      fireEvent.click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
      )
      expect(agentPickerLaunchInputs(onUse.mock.calls[0][0], own)).not.toHaveProperty('agentArgs')
    }
    fireEvent.click(chip!)
    expect(host.querySelector('button[aria-label*="Remove --settings"]')).toBeNull()
    for (const way of ['Launch chat', 'Launch terminal']) {
      onUse.mockClear()
      fireEvent.click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
      )
      const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
      expect(launch.sessionOptions?.fastMode).toBe('false')
      if (way === 'Launch terminal') {
        expect(shell.tokenizeStartupCommand(launch.agentArgs ?? '', 'posix')).toMatchObject({
          ok: true,
          tokens: [
            '--model',
            model,
            '--settings',
            '{"theme":"light","fastMode":false}',
            '--add-dir',
            'docs'
          ]
        })
      }
    }
  }
)

it('enables recorded Codex tier choices after defaults become known without inventing an inherited tier', async () => {
  const { default: capture } =
    await import('../../../../shared/fixtures/agent-picker-cli-recordings.json')
  const listing = await fetchCodexModelCatalogListing({
    connection: { request: vi.fn().mockResolvedValue(capture.modelList) }
  })
  const model = listing.models[0]
  const tier = model.serviceTiers![0]
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    label: 'Codex',
    defaultSurface: 'terminal',
    arguments: '',
    terminal: { model: model.id, permissionMode: 'ask' },
    structured: { model: model.id, permissionMode: 'ask' },
    catalog: { origin: 'probe', fetchedAt: 1, models: [model] }
  }
  const show = (value: AgentPickerEntry) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={value} onUse={onUse} />
        </TooltipProvider>
      )
    )
  const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const fast = () => radios().find((radio) => radio.textContent === tier.label)!
  const standard = () => radios().find((radio) => radio.textContent === 'Standard')!
  show({ ...own, arguments: undefined, defaultsPending: true, structuredDefaultsPending: true })
  expect(fast().disabled).toBe(true)
  expect(standard().disabled).toBe(true)
  show(own)
  expect(fast().disabled).toBe(false)
  expect(standard().disabled).toBe(false)
  expect(fast().getAttribute('aria-checked')).toBe('false')
  expect(standard().getAttribute('aria-checked')).toBe('false')
  const launch = (way: string) => {
    onUse.mockClear()
    fireEvent.click(
      [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
    )
    return agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
  }
  for (const way of ['Launch chat', 'Launch terminal']) {
    expect(launch(way)).toEqual({})
  }
  fireEvent.click(fast())
  expect(fast().getAttribute('aria-checked')).toBe('true')
  expect(launch('Launch chat').sessionOptions?.serviceTier).toBe(tier.value)
  const terminal = launch('Launch terminal')
  expect(terminal.sessionOptions?.serviceTier).toBe(tier.value)
  expect(terminal.agentArgs).toContain(`service_tier=${tier.value}`)
  expect(terminal.sessionOptions?.permissionMode).toBe('ask')
  fireEvent.click(standard())
  expect(standard().getAttribute('aria-checked')).toBe('true')
  expect(launch('Launch chat').sessionOptions?.serviceTier).toBe('default')
  expect(launch('Launch terminal').agentArgs).toContain('service_tier=default')
})

it.each([`--settings '{"fastMode":true}' --settings ./team.json`, `--settings '{broken'`])(
  'keeps opaque effective settings literal and Fast unclaimed: %s',
  (args) => {
    const own: AgentPickerEntry = {
      ...entry,
      defaultSurface: 'terminal',
      terminal: { model: 'opus', permissionMode: 'ask' },
      structured: { model: 'opus', permissionMode: 'ask', options: { fastMode: 'true' } },
      arguments: args,
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          { id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true }
        ]
      }
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={own} onUse={onUse} />
        </TooltipProvider>
      )
    )
    expect(host.textContent).toContain('Set by your Arguments')
    expect(host.querySelector('[role="switch"]')).toBeNull()
    expect(host.querySelector('button[aria-label*="Remove --settings"]')).toBeNull()
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value).toBe(
      args
    )
    for (const way of ['Launch chat', 'Launch terminal']) {
      onUse.mockClear()
      fireEvent.click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
      )
      const input = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
      expect(input.sessionOptions?.fastMode).toBeUndefined()
      expect(input).not.toHaveProperty('agentArgs')
    }
  }
)
