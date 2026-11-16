// @vitest-environment happy-dom
// The wizard's "Connect your GitHub so PRs show as you" line.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VmBuildGitHubIdentityLine } from './VmBuildGitHubIdentityLine'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement
type User = { connected: boolean; login?: string; githubUserId?: number }
const api: { user: User; connect: ReturnType<typeof vi.fn> } = {
  user: { connected: false },
  connect: vi.fn(async () => ({ ok: true, value: null }))
}

beforeEach(() => {
  localStorage.clear()
  api.user = { connected: false }
  api.connect.mockClear()
  Reflect.set(window, 'api', {
    orcaCloudWorkspace: {
      getGitHubUser: async () => ({ ok: true, value: api.user }),
      connectGitHubUser: api.connect,
      disconnectGitHubUser: async () => ({ ok: true, value: { connected: false } })
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function mount(): Promise<void> {
  root = createRoot(container)
  await act(async () => root!.render(<VmBuildGitHubIdentityLine />))
}

const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name) ?? null

describe('the GitHub identity line in the create wizard', () => {
  it('not connected: asks, and Connect opens GitHub', async () => {
    await mount()
    expect(container.textContent).toContain('Connect your GitHub so PRs show as you.')
    await act(async () => button('Connect GitHub')!.click())
    expect(api.connect).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Waiting for GitHub')
  })

  it('connected while the sheet is open: says who PRs show as', async () => {
    await mount()
    await act(async () => button('Connect GitHub')!.click())
    api.user = { connected: true, login: 'octo-dev', githubUserId: 1 }
    await act(async () => window.dispatchEvent(new Event('focus')))
    await vi.waitFor(() =>
      expect(container.textContent).toContain('PRs from this workspace show as @octo-dev.')
    )
  })

  it('already connected: nothing to say', async () => {
    api.user = { connected: true, login: 'octo-dev', githubUserId: 1 }
    await mount()
    expect(container.textContent).toBe('')
  })

  it('Not now hides it, and the next create doesn’t ask again', async () => {
    await mount()
    await act(async () => button('Not now')!.click())
    expect(container.textContent).toBe('')
    await act(async () => root!.unmount())
    await mount()
    expect(container.textContent).toBe('')
  })

  it('no answer (signed out, older control plane): hidden rather than guessing', async () => {
    Reflect.set(window, 'api', {
      orcaCloudWorkspace: {
        getGitHubUser: async () => ({ ok: false, code: 'failed', message: 'x' })
      }
    })
    await mount()
    expect(container.textContent).toBe('')
  })
})
