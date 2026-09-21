// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
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
  executionHostId?: ExecutionHostId | null
  onSubmit?: (configDir: string | null) => Promise<boolean> | boolean
}

async function render(args: RenderArgs = {}): Promise<{
  onSubmit: ReturnType<typeof vi.fn>
  onOpenChange: ReturnType<typeof vi.fn>
}> {
  const onSubmit = vi.fn(args.onSubmit ?? (() => Promise.resolve(true)))
  const onOpenChange = vi.fn()
  await act(async () => {
    root.render(
      <ProjectGroupSettingsDialog
        open
        groupName="Child"
        configDir={args.configDir ?? null}
        inherited={args.inherited ?? null}
        executionHostId={args.executionHostId ?? 'local'}
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

function liveRegion(): Element {
  const region = container.querySelector('[data-claude-config-dir-live]')
  if (!region) {
    throw new Error('advisory live region not found')
  }
  return region
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
      executionHostId: 'ssh:prod-1'
    })

    expect(mocks.pathExists).not.toHaveBeenCalled()
    expect(advisoryText()).toBe('')
  })

  it('never probes the client filesystem for a runtime-environment-owned group', async () => {
    await render({
      configDir: '/home/alice/.claude-child',
      executionHostId: 'runtime:env-1'
    })

    expect(mocks.pathExists).not.toHaveBeenCalled()
    expect(advisoryText()).toBe('')
  })

  it('offers no client folder picker for a group owned by another host', async () => {
    await render({
      configDir: '/home/alice/.claude-child',
      executionHostId: 'ssh:prod-1'
    })

    expect(() => findButton('Browse')).toThrow()
    expect(container.textContent).toContain('prod-1')
  })

  it('brings the inherited hint back when a bound group clears its field', async () => {
    await render({ configDir: '/home/alice/.claude-child', inherited: INHERITED })
    expect(container.textContent).not.toContain('Client Work')

    await type('')

    expect(container.textContent).toContain('Client Work')
    expect(container.textContent).toContain('/home/alice/.claude-client')
  })

  it('keeps the dialog open with the draft intact when the save is refused', async () => {
    const { onOpenChange } = await render({
      configDir: null,
      onSubmit: () => Promise.resolve(false)
    })

    await type('/home/alice/.claude-child')
    await act(async () => {
      findButton('Save').click()
    })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(getInput().value).toBe('/home/alice/.claude-child')
    expect(findButton('Save').disabled).toBe(false)
  })

  it('announces the advisory once, as a live region only', async () => {
    mocks.pathExists.mockResolvedValue(false)
    await render({ configDir: '/home/alice/.claude-child' })

    expect(advisoryText()).toContain('does not exist')
    expect(getInput().getAttribute('aria-describedby')).toBeNull()
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
  })

  // N5: a live region announces a mutation, so the region has to already be in the DOM — and
  // empty — before the first advisory arrives, or an advisory present at open is never announced.
  it('mounts the live region empty when there is nothing to announce', async () => {
    await render({ configDir: null })

    expect(liveRegion().textContent).toBe('')
    expect(liveRegion().getAttribute('role')).toBe('status')
  })

  it('announces an advisory that is already true at open time', async () => {
    // A stored relative binding needs no probe: the advice is synchronous at first paint.
    await render({ configDir: '.claude-relative' })

    expect(liveRegion().textContent).toContain('absolute')
  })

  it('fills the same live-region node rather than mounting a new one with the text', async () => {
    await render({ configDir: null })
    const before = liveRegion()

    await type('.claude')

    expect(liveRegion()).toBe(before)
    expect(liveRegion().textContent).toContain('absolute')
  })

  it('closes the dialog when the save lands', async () => {
    const { onOpenChange } = await render({
      configDir: null,
      onSubmit: () => Promise.resolve(true)
    })

    await type('/home/alice/.claude-child')
    await act(async () => {
      findButton('Save').click()
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
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
