// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedAgentSessionFork } from './terminal-agent-session-fork'

type ButtonProps = {
  disabled?: boolean
  onClick?: () => void
  children?: React.ReactNode
}

type ToggleGroupProps = {
  onValueChange?: (value: string) => void
  children?: React.ReactNode
}

type ToggleGroupItemProps = {
  value: string
  children?: React.ReactNode
}

type InputProps = {
  disabled?: boolean
  id?: string
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  value?: string
}

type CheckboxProps = {
  checked?: boolean
  disabled?: boolean
  id?: string
  onCheckedChange?: (checked: boolean) => void
}

type SelectProps = {
  children?: React.ReactNode
  disabled?: boolean
  onValueChange?: (value: string) => void
  value?: string
}

type SelectItemProps = {
  children?: React.ReactNode
  value: string
}

const mocks = vi.hoisted(() => ({
  copyAgentSessionForkContext: vi.fn(),
  preflightAgentSessionFork: vi.fn(),
  startAgentSessionFork: vi.fn()
}))

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react')
  return {
    Button: (props: ButtonProps) =>
      ReactModule.createElement(
        'button',
        { disabled: props.disabled, onClick: props.onClick, type: 'button' },
        props.children
      )
  }
})

vi.mock('@/components/ui/dialog', async () => {
  const ReactModule = await import('react')
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? ReactModule.createElement('div', null, children) : null,
    DialogContent: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('div', null, children),
    DialogDescription: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('p', null, children),
    DialogFooter: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('footer', null, children),
    DialogHeader: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('header', null, children),
    DialogTitle: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('h2', null, children)
  }
})

vi.mock('@/components/ui/input', async () => {
  const ReactModule = await import('react')
  return {
    Input: (props: InputProps) =>
      ReactModule.createElement('input', {
        disabled: props.disabled,
        id: props.id,
        onChange: props.onChange,
        onInput: props.onChange,
        placeholder: props.placeholder,
        value: props.value
      })
  }
})

vi.mock('@/components/ui/label', async () => {
  const ReactModule = await import('react')
  return {
    Label: ({ children, htmlFor }: { children?: React.ReactNode; htmlFor?: string }) =>
      ReactModule.createElement('label', { htmlFor }, children)
  }
})

vi.mock('@/components/ui/checkbox', async () => {
  const ReactModule = await import('react')
  return {
    Checkbox: (props: CheckboxProps) =>
      ReactModule.createElement('input', {
        checked: props.checked,
        disabled: props.disabled,
        id: props.id,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          props.onCheckedChange?.(event.target.checked),
        type: 'checkbox'
      })
  }
})

vi.mock('@/components/ui/select', async () => {
  const ReactModule = await import('react')
  const SelectContext = ReactModule.createContext<{
    onValueChange: ((value: string) => void) | undefined
    disabled: boolean | undefined
  }>({ onValueChange: undefined, disabled: undefined })
  return {
    Select: (props: SelectProps) =>
      ReactModule.createElement(
        SelectContext.Provider,
        { value: { onValueChange: props.onValueChange, disabled: props.disabled } },
        ReactModule.createElement('div', { 'data-value': props.value }, props.children)
      ),
    SelectContent: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('div', null, children),
    SelectGroup: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement('div', null, children),
    SelectItem: (props: SelectItemProps) => {
      const context = ReactModule.useContext(SelectContext)
      return ReactModule.createElement(
        'button',
        {
          disabled: context.disabled,
          onClick: () => context.onValueChange?.(props.value),
          type: 'button'
        },
        props.children
      )
    },
    SelectTrigger: ({
      children,
      disabled,
      id
    }: {
      children?: React.ReactNode
      disabled?: boolean
      id?: string
    }) => ReactModule.createElement('button', { disabled, id, type: 'button' }, children),
    SelectValue: () => ReactModule.createElement('span', null)
  }
})

vi.mock('@/components/ui/toggle-group', async () => {
  const ReactModule = await import('react')
  const TargetModeContext = ReactModule.createContext<((value: string) => void) | null>(null)
  return {
    ToggleGroup: (props: ToggleGroupProps) =>
      ReactModule.createElement(
        TargetModeContext.Provider,
        { value: props.onValueChange ?? null },
        ReactModule.createElement('div', null, props.children)
      ),
    ToggleGroupItem: (props: ToggleGroupItemProps) => {
      const onValueChange = ReactModule.useContext(TargetModeContext)
      return ReactModule.createElement(
        'button',
        { onClick: () => onValueChange?.(props.value), type: 'button' },
        props.children
      )
    }
  }
})

vi.mock('./terminal-agent-session-fork', () => ({
  copyAgentSessionForkContext: mocks.copyAgentSessionForkContext,
  preflightAgentSessionFork: mocks.preflightAgentSessionFork,
  startAgentSessionFork: mocks.startAgentSessionFork
}))

const roots: Root[] = []

function makeFork(): PreparedAgentSessionFork {
  return {
    prompt: 'fork prompt',
    agent: null,
    worktreeId: 'wt-1',
    groupId: 'group-1',
    terminalHandle: 'term-1',
    pane: {} as PreparedAgentSessionFork['pane']
  }
}

async function renderDialog(
  fork: PreparedAgentSessionFork,
  onOpenChange = vi.fn()
): Promise<HTMLDivElement> {
  const { TerminalAgentSessionForkDialog } = await import('./TerminalAgentSessionForkDialog')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(<TerminalAgentSessionForkDialog open fork={fork} onOpenChange={onOpenChange} />)
  })

  return container
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label)
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function getInput(container: HTMLElement, placeholder: string): HTMLInputElement {
  const input = [...container.querySelectorAll('input')].find(
    (node) => node.placeholder === placeholder
  )
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${placeholder}`)
  }
  return input
}

describe('TerminalAgentSessionForkDialog', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.copyAgentSessionForkContext.mockReset()
    mocks.preflightAgentSessionFork.mockReset()
    mocks.preflightAgentSessionFork.mockReturnValue(new Promise(() => undefined))
    mocks.startAgentSessionFork.mockReset()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('prevents busy-state double submit for create', async () => {
    mocks.startAgentSessionFork.mockReturnValue(new Promise(() => undefined))
    const container = await renderDialog(makeFork())
    const createButton = getButton(container, 'Create fork')

    await act(async () => {
      createButton.click()
      createButton.click()
    })

    expect(mocks.startAgentSessionFork).toHaveBeenCalledTimes(1)
  })

  it('starts a child workspace fork by default', async () => {
    mocks.startAgentSessionFork.mockResolvedValue(true)
    const fork = makeFork()
    const onOpenChange = vi.fn()
    const container = await renderDialog(fork, onOpenChange)

    await act(async () => {
      getButton(container, 'Create fork').click()
    })

    expect(mocks.startAgentSessionFork).toHaveBeenCalledWith(fork, {
      activate: true,
      noCopyFiles: false
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows provider-native preflight details from runtime', async () => {
    mocks.preflightAgentSessionFork.mockResolvedValueOnce({
      sourceTerminalHandle: 'term-1',
      sourceWorktreeId: 'wt-1',
      workspaceMode: 'child-workspace',
      contextDelivery: {
        mode: 'native-provider',
        promptDelivery: 'startup-agent',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        agent: 'claude'
      }
    })

    const fork = makeFork()
    const container = await renderDialog(fork)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.preflightAgentSessionFork).toHaveBeenCalledWith(fork, {
      noCopyFiles: false
    })
    expect(container.textContent).toContain('Provider-native fork available for claude.')
  })

  it('shows structured history fallback preflight details from runtime', async () => {
    mocks.preflightAgentSessionFork.mockResolvedValueOnce({
      sourceTerminalHandle: 'term-1',
      sourceWorktreeId: 'wt-1',
      workspaceMode: 'child-workspace',
      contextDelivery: {
        mode: 'structured-history-fallback',
        promptDelivery: 'startup-agent',
        includedPromptCount: 2,
        nativeProviderReason: 'provider-native-fork-unsupported',
        agent: 'gemini'
      }
    })

    const fork = makeFork()
    const container = await renderDialog(fork)
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain(
      'Structured history fallback planned with 2 recorded prompts'
    )
    expect(container.textContent).toContain('the source agent does not support native forking')
  })

  it('refreshes preflight details for current workspace forks', async () => {
    mocks.preflightAgentSessionFork
      .mockResolvedValueOnce({
        sourceTerminalHandle: 'term-1',
        sourceWorktreeId: 'wt-1',
        workspaceMode: 'child-workspace',
        contextDelivery: {
          mode: 'native-provider',
          promptDelivery: 'startup-agent',
          providerSession: { key: 'session_id', id: 'claude-session-1' },
          agent: 'claude'
        }
      })
      .mockResolvedValueOnce({
        sourceTerminalHandle: 'term-1',
        sourceWorktreeId: 'wt-1',
        workspaceMode: 'same-workspace',
        contextDelivery: {
          mode: 'transcript-fallback',
          promptDelivery: 'startup-agent',
          transcriptLineCount: 12,
          transcriptTruncated: true,
          nativeProviderReason: 'provider-session-metadata-unavailable',
          agent: 'codex'
        }
      })

    const fork = makeFork()
    const container = await renderDialog(fork)
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      getButton(container, 'Current workspace').click()
      await Promise.resolve()
    })

    expect(mocks.preflightAgentSessionFork).toHaveBeenLastCalledWith(fork, {
      noCopyFiles: true
    })
    expect(container.textContent).toContain('Transcript fallback planned: 12 terminal lines')
    expect(container.textContent).toContain('provider session metadata is unavailable')
  })

  it('passes a custom child workspace name and activation preference', async () => {
    mocks.startAgentSessionFork.mockResolvedValue(true)
    const fork = makeFork()
    const container = await renderDialog(fork)
    const nameInput = getInput(container, 'Auto-generate from source workspace')
    const openAfterCreate = container.querySelector('input[type="checkbox"]')
    expect(openAfterCreate).toBeInstanceOf(HTMLInputElement)

    await act(async () => {
      nameInput.value = 'named-fork'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      ;(openAfterCreate as HTMLInputElement).click()
    })
    await act(async () => {
      getButton(container, 'Create fork').click()
    })

    expect(mocks.startAgentSessionFork).toHaveBeenCalledWith(fork, {
      activate: false,
      name: 'named-fork',
      noCopyFiles: false
    })
  })

  it('passes noCopyFiles for current workspace forks', async () => {
    mocks.startAgentSessionFork.mockResolvedValue(true)
    const fork = makeFork()
    const container = await renderDialog(fork)

    await act(async () => {
      getButton(container, 'Current workspace').click()
    })
    expect(container.textContent).toContain('No files are copied.')

    await act(async () => {
      getButton(container, 'Create fork').click()
    })

    expect(mocks.startAgentSessionFork).toHaveBeenCalledWith(fork, {
      activate: true,
      noCopyFiles: true
    })
  })

  it('passes a selected structured message fork point through preflight and create', async () => {
    mocks.preflightAgentSessionFork
      .mockResolvedValueOnce({
        sourceTerminalHandle: 'term-1',
        sourceWorktreeId: 'wt-1',
        workspaceMode: 'child-workspace',
        availableForkPoints: [
          {
            forkPoint: { kind: 'message', id: 'opencode-message-1' },
            prompt: 'first prompt before fork',
            observedAt: 1_000,
            agent: 'codex'
          }
        ],
        contextDelivery: {
          mode: 'transcript-fallback',
          promptDelivery: 'startup-agent',
          transcriptLineCount: 12,
          transcriptTruncated: false,
          nativeProviderReason: 'provider-session-metadata-unavailable',
          agent: 'codex'
        }
      })
      .mockResolvedValueOnce({
        sourceTerminalHandle: 'term-1',
        sourceWorktreeId: 'wt-1',
        workspaceMode: 'child-workspace',
        forkPoint: { kind: 'message', id: 'opencode-message-1' },
        availableForkPoints: [
          {
            forkPoint: { kind: 'message', id: 'opencode-message-1' },
            prompt: 'first prompt before fork',
            observedAt: 1_000,
            agent: 'codex'
          }
        ],
        contextDelivery: {
          mode: 'structured-message-fallback',
          promptDelivery: 'startup-agent',
          forkPoint: { kind: 'message', id: 'opencode-message-1' },
          includedPromptCount: 1,
          nativeProviderReason: 'message-fork-point-selected',
          agent: 'codex'
        }
      })
    mocks.startAgentSessionFork.mockResolvedValue(true)
    const fork = makeFork()
    const container = await renderDialog(fork)

    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      getButton(container, 'Message 1: first prompt before fork').click()
      await Promise.resolve()
    })
    await act(async () => {
      getButton(container, 'Create fork').click()
    })

    expect(mocks.preflightAgentSessionFork).toHaveBeenLastCalledWith(fork, {
      message: 'opencode-message-1',
      noCopyFiles: false
    })
    expect(mocks.startAgentSessionFork).toHaveBeenCalledWith(fork, {
      activate: true,
      message: 'opencode-message-1',
      noCopyFiles: false
    })
  })
})
