// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from '@/components/ui/command'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'
import { TabBarQuickCommandItem } from './TabBarQuickCommandItem'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    if (!values) {
      return fallback
    }
    return Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null,
  getAgentLabel: (agent: string) => agent
}))

const entry: HostedTerminalQuickCommand = {
  key: 'local:cmd-1',
  hostId: 'local',
  hostLabel: 'This Mac',
  command: {
    id: 'cmd-1',
    label: 'Git status',
    action: 'terminal-command',
    command: 'git status',
    appendEnter: true,
    scope: { type: 'repo', repoId: 'repo-1' }
  }
}

let container: HTMLDivElement
let root: Root
let writeClipboardText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeClipboardText = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { ui: { writeClipboardText } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderItem(item: HostedTerminalQuickCommand = entry): {
  onRun: ReturnType<typeof vi.fn>
  onEdit: ReturnType<typeof vi.fn>
  onDelete: ReturnType<typeof vi.fn>
} {
  const onRun = vi.fn()
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  act(() => {
    root.render(
      createElement(
        Command,
        { shouldFilter: false },
        createElement(TabBarQuickCommandItem, {
          entry: item,
          showHostLabel: false,
          onRun,
          onEdit,
          onDelete
        })
      )
    )
  })
  return { onRun, onEdit, onDelete }
}

describe('TabBarQuickCommandItem', () => {
  it('copies the command body without running the command', async () => {
    const { onRun, onEdit, onDelete } = renderItem()

    const copyButton = container.querySelector('button[aria-label="Copy Git status"]')
    if (!(copyButton instanceof HTMLButtonElement)) {
      throw new Error('copy button not found')
    }

    await act(async () => {
      copyButton.click()
      await Promise.resolve()
    })

    expect(writeClipboardText).toHaveBeenCalledWith('git status')
    expect(onRun).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    expect(container.querySelector('button[aria-label="Copied"]')).not.toBeNull()
  })

  it('copies agent prompt text for agent quick commands', async () => {
    renderItem({
      key: 'local:agent-1',
      hostId: 'local',
      hostLabel: 'This Mac',
      command: {
        id: 'agent-1',
        label: 'Explore codebase',
        action: 'agent-prompt',
        agent: 'claude',
        prompt: 'Explore the auth module',
        scope: { type: 'global' }
      }
    })

    const copyButton = container.querySelector('button[aria-label="Copy Explore codebase"]')
    if (!(copyButton instanceof HTMLButtonElement)) {
      throw new Error('copy button not found')
    }

    await act(async () => {
      copyButton.click()
      await Promise.resolve()
    })

    expect(writeClipboardText).toHaveBeenCalledWith('Explore the auth module')
  })

  it('disables copy when the command body is empty', () => {
    renderItem({
      key: 'local:empty',
      hostId: 'local',
      hostLabel: 'This Mac',
      command: {
        id: 'empty',
        label: 'Empty',
        action: 'terminal-command',
        command: '   ',
        appendEnter: true,
        scope: { type: 'global' }
      }
    })

    const copyButton = container.querySelector('button[aria-label="Nothing to copy"]')
    if (!(copyButton instanceof HTMLButtonElement)) {
      throw new Error('disabled copy button not found')
    }
    expect(copyButton.disabled).toBe(true)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('surfaces clipboard failure without claiming success', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('denied'))
    renderItem()

    const copyButton = container.querySelector('button[aria-label="Copy Git status"]')
    if (!(copyButton instanceof HTMLButtonElement)) {
      throw new Error('copy button not found')
    }

    await act(async () => {
      copyButton.click()
      await Promise.resolve()
    })

    expect(container.querySelector('button[aria-label="Couldn\'t copy"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Copied"]')).toBeNull()
  })

  it('prevents nested action pointerdown from selecting the command row', () => {
    const { onRun } = renderItem()
    const copyButton = container.querySelector('button[aria-label="Copy Git status"]')
    if (!(copyButton instanceof HTMLButtonElement)) {
      throw new Error('copy button not found')
    }

    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    const stopPropagation = vi.spyOn(event, 'stopPropagation')
    const preventDefault = vi.spyOn(event, 'preventDefault')
    act(() => {
      copyButton.dispatchEvent(event)
    })

    expect(stopPropagation).toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalled()
    expect(onRun).not.toHaveBeenCalled()
  })
})
