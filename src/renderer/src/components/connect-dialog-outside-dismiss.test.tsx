// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'

import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BitbucketCredentialsDialog } from './integrations/source-control/bitbucket-credentials-dialog'

type StoreState = {
  settings: { activeRuntimeEnvironmentId: string | null }
  connectJira: (input: unknown) => Promise<{ ok: boolean; error?: string }>
  connectLinear: (apiKey: string) => Promise<{ ok: boolean; error?: string }>
}

const mocks = vi.hoisted(() => {
  const store: { current: StoreState | null } = { current: null }
  return { store }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

let root: Root | null = null

beforeEach(() => {
  mocks.store.current = {
    settings: { activeRuntimeEnvironmentId: null },
    connectJira: vi.fn(async () => ({ ok: true })),
    connectLinear: vi.fn(async () => ({ ok: true }))
  }
})

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  document.body.innerHTML = ''
  mocks.store.current = null
})

async function renderDialog(ui: ReactElement, existingRoot?: Root): Promise<Root> {
  const targetRoot = existingRoot ?? createRoot(appendContainer())
  root = targetRoot
  await act(async () => {
    targetRoot.render(ui)
  })
  // Radix installs outside-pointer listeners on setTimeout(0); wait before dispatching.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return targetRoot
}

function appendContainer(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return container
}

async function outsideClick(): Promise<void> {
  await act(async () => {
    // Modal dismissal waits for click after outside pointerdown; bubble both to the document listeners.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!input) {
    throw new Error(`missing input with placeholder ${placeholder}`)
  }
  return input
}

describe('BitbucketCredentialsDialog outside dismiss', () => {
  it('keeps a typed draft when the stored metadata is refreshed mid-edit', async () => {
    const onOpenChange = vi.fn()
    const targetRoot = await renderDialog(
      <BitbucketCredentialsDialog
        open
        onOpenChange={onOpenChange}
        initialEmail="first@example.com"
      />
    )
    const email = inputByPlaceholder('you@example.com')
    await type(email, 'typed@example.com')

    await renderDialog(
      <BitbucketCredentialsDialog
        open
        onOpenChange={onOpenChange}
        initialEmail="refreshed@example.com"
      />,
      targetRoot
    )
    await outsideClick()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(email.value).toBe('typed@example.com')
  })
})
