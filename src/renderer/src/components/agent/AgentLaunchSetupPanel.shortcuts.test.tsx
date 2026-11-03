// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent, getByRole, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  AgentLaunchSetupPanel,
  entry,
  host,
  root,
  onUse
} from './agent-launch-setup-panel-test-fixture'
import { changePrompt } from '../native-chat/native-chat-prompt-editor.test-support'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
import type { AgentPickerSurface } from '../../../../shared/agent-launch-picker'

beforeEach(() => clearNativeChatComposerDraftsForTests())
afterEach(() => vi.restoreAllMocks())

function renderPanel({
  defaultSurface = 'terminal',
  surfaces = ['chat', 'terminal'],
  disabled = false
}: {
  defaultSurface?: AgentPickerSurface
  surfaces?: AgentPickerSurface[]
  disabled?: boolean
} = {}) {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel
          entry={{
            ...entry,
            worktreeId: 'shortcut-worktree',
            defaultSurface,
            surfaces,
            arguments: undefined,
            terminal: { model: 'selected' },
            structured: { model: 'selected' },
            catalog: {
              origin: 'probe',
              fetchedAt: 1,
              models: [{ id: 'selected', label: 'Selected', efforts: [], isDefault: true }]
            }
          }}
          disabled={disabled}
          onUse={onUse}
        />
      </TooltipProvider>
    )
  )
}

function prompt(): HTMLElement {
  return host.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
}

const cases = ['Macintosh', 'Windows NT 10.0', 'X11; Linux x86_64'].flatMap((userAgent) =>
  (['terminal', 'chat'] as const).flatMap((defaultSurface) =>
    (['prompt', 'model', 'arguments'] as const).map((target) => ({
      userAgent,
      defaultSurface,
      target
    }))
  )
)

it.each(cases)(
  'launches the alternative to $defaultSurface from $target on $userAgent',
  async ({ userAgent, defaultSurface, target }) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    renderPanel({ defaultSurface })
    changePrompt(prompt(), 'inspect the selected workspace')
    if (target === 'arguments' && !host.querySelector('textarea')) {
      fireEvent.click(getByRole(host, 'button', { name: 'Toggle Arguments' }))
    }
    const input =
      target === 'prompt'
        ? prompt()
        : target === 'model'
          ? host.querySelector('[cmdk-input]')!
          : host.querySelector('textarea')!
    const mac = userAgent.includes('Mac')
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, metaKey: mac, ctrlKey: !mac })
    const alternate = defaultSurface === 'terminal' ? 'chat' : 'terminal'
    await waitFor(() =>
      expect(onUse).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          surface: alternate,
          prompt: 'inspect the selected workspace'
        })
      )
    )
    const button = getByRole(host, 'button', { name: `Launch ${alternate}` })
    expect(button.getAttribute('aria-keyshortcuts')).toBe(mac ? 'Meta+Enter' : 'Control+Enter')
    expect(button.textContent).toContain(mac ? '⌘' : 'Ctrl')
    expect(
      getByRole(host, 'button', { name: `Launch ${defaultSurface}` }).getAttribute(
        'aria-keyshortcuts'
      )
    ).toBe('Enter')
  }
)

it.each(['Macintosh', 'Windows NT 10.0'])(
  'launches the alternative with an empty prompt on %s',
  async (userAgent) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    renderPanel()
    const mac = userAgent.includes('Mac')
    fireEvent.keyDown(prompt(), { key: 'Enter', keyCode: 13, metaKey: mac, ctrlKey: !mac })
    await waitFor(() =>
      expect(onUse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ surface: 'chat' }))
    )
    expect(onUse.mock.calls[0][0].prompt).toBeUndefined()
  }
)

it.each(['disabled', 'single-surface', 'repeat', 'composition', 'shift'] as const)(
  'does not launch through the alternative shortcut during %s',
  (state) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    renderPanel({
      disabled: state === 'disabled',
      surfaces: state === 'single-surface' ? ['terminal'] : ['chat', 'terminal']
    })
    fireEvent.keyDown(state === 'composition' ? host.querySelector('textarea')! : prompt(), {
      key: 'Enter',
      keyCode: 13,
      metaKey: true,
      isComposing: state === 'composition',
      repeat: state === 'repeat',
      shiftKey: state === 'shift'
    })
    expect(onUse).not.toHaveBeenCalled()
  }
)
