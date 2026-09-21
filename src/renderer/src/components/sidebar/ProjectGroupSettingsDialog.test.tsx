// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InheritedClaudeConfigDir } from './project-group-claude-config-dir-selection'
import { ProjectGroupSettingsDialog } from './ProjectGroupSettingsDialog'

const mocks = vi.hoisted(() => ({
  pathExists: vi.fn(),
  pickDirectory: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
}))

// Why: Radix Dialog portals into document.body and needs pointer APIs happy-dom lacks; a plain
// element keeps the content, the open flag and the dismissal callback assertable.
vi.mock('@/components/ui/dialog', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div data-dialog="">{children}</div> : null,
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough
  }
})

const INHERITED: InheritedClaudeConfigDir = {
  configDir: '/home/alice/.claude-client',
  groupId: 'parent',
  groupName: 'Client Work'
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.pathExists.mockReset()
  mocks.pathExists.mockResolvedValue(true)
  mocks.pickDirectory.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: {
        pathExists: mocks.pathExists,
        pickDirectory: mocks.pickDirectory
      }
    }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

type RenderArgs = {
  configDir?: string | null
  inherited?: InheritedClaudeConfigDir | null
  connectionId?: string | null
  onSubmit?: (configDir: string | null) => Promise<void> | void
}

async function render(args: RenderArgs = {}): Promise<{
  onSubmit: ReturnType<typeof vi.fn>
  onOpenChange: ReturnType<typeof vi.fn>
}> {
  const onSubmit = vi.fn(args.onSubmit ?? (() => Promise.resolve()))
  const onOpenChange = vi.fn()
  await act(async () => {
    root.render(
      <ProjectGroupSettingsDialog
        open
        groupName="Child"
        configDir={args.configDir ?? null}
        inherited={args.inherited ?? null}
        connectionId={args.connectionId ?? null}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />
    )
  })
  await flushProbe()
  return { onSubmit, onOpenChange }
}

/** Real timers: the probe debounces, so the advisory needs the debounce window to elapse. */
async function flushProbe(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320))
  })
}

function getInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) {
    throw new Error('config directory input not found')
  }
  return input
}

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((entry) =>
    entry.textContent?.trim().includes(text)
  )
  if (!button) {
    throw new Error(`button "${text}" not found`)
  }
  return button
}

function advisoryText(): string {
  return container.querySelector('[data-claude-config-dir-advice]')?.textContent ?? ''
}

async function type(value: string): Promise<void> {
  const input = getInput()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flushProbe()
}

describe('ProjectGroupSettingsDialog', () => {
  it('names the ancestor group when the binding is inherited', async () => {
    await render({ configDir: null, inherited: INHERITED })

    expect(container.textContent).toContain('Client Work')
    expect(container.textContent).toContain('/home/alice/.claude-client')
  })

  it('shows no inherited hint when the group has its own binding', async () => {
    await render({ configDir: '/home/alice/.claude-child', inherited: null })

    expect(container.textContent).not.toContain('Inherited')
    expect(getInput().value).toBe('/home/alice/.claude-child')
  })

  it('drops the inherited hint once the group is given its own directory', async () => {
    await render({ configDir: null, inherited: INHERITED })
    expect(container.textContent).toContain('Client Work')

    await type('/home/alice/.claude-child')

    expect(container.textContent).not.toContain('Client Work')
  })

  it('writes null through the clear action', async () => {
    const { onSubmit } = await render({
      configDir: '/home/alice/.claude-child'
    })

    await act(async () => {
      findButton('Clear').click()
    })

    expect(onSubmit).toHaveBeenCalledWith(null)
  })

  it('flags a relative path inline but still allows saving it', async () => {
    const { onSubmit } = await render({ configDir: null })

    await type('.claude')

    expect(advisoryText()).toContain('absolute')
    const save = findButton('Save')
    expect(save.disabled).toBe(false)

    await act(async () => {
      save.click()
    })

    expect(onSubmit).toHaveBeenCalledWith('.claude')
  })

  it('advises when the directory has no Claude credentials yet', async () => {
    mocks.pathExists.mockImplementation(
      async (filePath: string) => !filePath.endsWith('.credentials.json')
    )

    await render({ configDir: '/home/alice/.claude-child' })

    expect(advisoryText()).toContain('signed out')
  })

  it('advises when the directory does not exist', async () => {
    mocks.pathExists.mockResolvedValue(false)

    await render({ configDir: '/home/alice/.claude-child' })

    expect(advisoryText()).toContain('does not exist')
  })

  it('never probes the client filesystem for a group owned by an SSH host', async () => {
    await render({
      configDir: '/home/alice/.claude-child',
      connectionId: 'ssh-target-1'
    })

    expect(mocks.pathExists).not.toHaveBeenCalled()
    expect(advisoryText()).toBe('')
  })

  it('seeds the platform directory picker with the current draft', async () => {
    mocks.pickDirectory.mockResolvedValue('/home/alice/.claude-picked')
    await render({ configDir: '/home/alice/.claude-child' })

    await act(async () => {
      findButton('Browse').click()
    })
    await flushProbe()

    expect(mocks.pickDirectory).toHaveBeenCalledWith({
      defaultPath: '/home/alice/.claude-child'
    })
    expect(getInput().value).toBe('/home/alice/.claude-picked')
  })
})
