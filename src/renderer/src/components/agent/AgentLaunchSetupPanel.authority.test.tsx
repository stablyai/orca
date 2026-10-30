// @vitest-environment happy-dom
import { entry, host, root, onUse } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import * as shell from '../../../../shared/tui-agent-startup-shell'
import { resolveAgentLaunchCommand } from '../../../../shared/tui-agent-launch-command'
import {
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

it('uses chat-style permission icons and separated own settings while keeping raw CLI text selected', () => {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={entry} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Claude permissions"]')!
  expect(trigger.textContent).toBe('plan')
  expect(trigger.querySelector('svg.lucide-terminal')).not.toBeNull()
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  const raw = rows.find((row) => row.textContent === 'plan')!
  expect(raw.getAttribute('aria-checked')).toBe('true')
  expect(raw.querySelector('svg.lucide-terminal')).not.toBeNull()
  const full = rows.find((row) => row.textContent?.startsWith('Full access'))!
  expect(full.querySelector('.text-status-warning svg')).not.toBeNull()
  expect(full.textContent).toContain('Never asks before edits or commands')
  const own = rows.find((row) => row.textContent?.includes("Use Claude's own settings"))!
  expect(own.previousElementSibling?.getAttribute('role')).toBe('separator')
  expect(own.querySelector('svg.lucide-terminal')).not.toBeNull()
  expect(rows.some((row) => row.textContent?.includes('Same as all agents'))).toBe(false)
  fireEvent.click(full)
  expect(trigger.querySelector('.text-status-warning svg')).not.toBeNull()
  expect(onUse).not.toHaveBeenCalled()
})

it.each(['missing-default', 'pending', 'known-default', 'explicit'] as const)(
  'keeps Effort authority separate from declared choices: %s',
  (state) => {
    const own: AgentPickerEntry = {
      ...entry,
      arguments: '--model opus',
      defaultsPending: state === 'pending',
      structuredDefaultsPending: state === 'pending',
      terminal: {
        model: 'opus',
        permissionMode: 'ask',
        ...(state === 'explicit' || state === 'pending' ? { options: { effort: 'high' } } : {})
      },
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: 'opus',
            label: 'Opus',
            isDefault: true,
            supportsFastMode: true,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ],
            ...(state === 'known-default' ? { defaultEffort: 'low' } : {})
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
    const radios = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-option-id="effort"] [role="radio"]')
    ]
    expect(radios).toHaveLength(2)
    expect(radios.every((radio) => radio.disabled)).toBe(state === 'pending')
    expect(
      host.querySelector<HTMLButtonElement>('[data-option-id="fastMode"] [role="switch"]')?.disabled
    ).toBe(state === 'pending')
    if (state === 'known-default' || state === 'explicit') {
      expect(
        radios.find((radio) => radio.getAttribute('aria-checked') === 'true')?.textContent
      ).toBe(state === 'known-default' ? 'Low' : 'High')
    }
    if (state === 'missing-default') {
      expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true)
    }
    for (const way of ['Launch chat', 'Launch terminal']) {
      onUse.mockClear()
      fireEvent.click(
        [...host.querySelectorAll('button')].find((button) => button.textContent === way)!
      )
      expect(agentPickerLaunchInputs(onUse.mock.calls[0][0], own)).toEqual({})
    }
  }
)

it('edits the QA inline settings carrier after verbose and compiles the same effective JSON', () => {
  const own: AgentPickerEntry = {
    ...entry,
    terminal: { model: 'opus', permissionMode: 'ask' },
    arguments: `--verbose --settings '{"language":"English","fastMode":false}'`,
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true }]
    }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={own} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const fast = host.querySelector<HTMLButtonElement>('[role="switch"]')
  expect(fast).not.toBeNull()
  expect(fast?.disabled).toBe(false)
  fireEvent.click(fast!)
  fireEvent.click(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Launch terminal')!
  )
  const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
  const compiled = resolveAgentLaunchCommand({
    agent: 'claude',
    cmdOverrides: {},
    platform: 'darwin',
    shell: 'posix',
    ...launch
  })
  expect(compiled.ok).toBe(true)
  if (!compiled.ok) {
    throw new Error(compiled.error)
  }
  const argv = shell.tokenizeStartupCommand(compiled.command, 'posix')
  expect(argv.ok).toBe(true)
  if (!argv.ok) {
    throw new Error(argv.error)
  }
  expect(argv.tokens.filter((token) => token === '--settings')).toHaveLength(1)
  expect(JSON.parse(argv.tokens[argv.tokens.indexOf('--settings') + 1])).toEqual({
    language: 'English',
    fastMode: true
  })
  expect(argv.tokens).toContain('--verbose')
})

it('keeps the QA unclosed permission literal once after Ask and preserves actual Terminal refusal', () => {
  const raw = '--verbose --permission-mode "plan'
  const own: AgentPickerEntry = { ...entry, arguments: raw }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={own} onUse={onUse} />
      </TooltipProvider>
    )
  )
  const permission = host.querySelector<HTMLButtonElement>('button[aria-label$=" permissions"]')!
  fireEvent.keyDown(permission, { key: 'ArrowDown' })
  fireEvent.click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.startsWith('Ask for approval')
    )!
  )
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value).toBe(
    raw
  )
  expect(host.querySelector('button[aria-label^="Remove --permission"]')).toBeNull()
  fireEvent.click(
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Launch terminal')!
  )
  const launch = agentPickerLaunchInputs(onUse.mock.calls[0][0], own)
  expect(launch.agentArgs).toBe(raw)
  expect(launch.sessionOptions?.permissionMode).toBe('ask')
  expect(
    resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix',
      ...launch
    })
  ).toEqual({ ok: false, error: 'CLI arguments are invalid: Unclosed quote in command template.' })
})
