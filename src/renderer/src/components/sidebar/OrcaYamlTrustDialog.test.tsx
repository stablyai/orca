// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = {
  activeModal: 'confirm-orca-yaml-hooks',
  modalData: {} as Record<string, unknown>,
  closeModal: vi.fn(),
  markOrcaHookScriptConfirmed: vi.fn(),
  markOrcaHookRepoAlwaysTrusted: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof storeState) => unknown) => selector(storeState)
}))

const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

async function renderTrustDialog(modalData: Record<string, unknown>): Promise<void> {
  storeState.modalData = { repoId: 'repo-1', repoName: 'Repo One', ...modalData }
  await act(async () => {
    root.render(<OrcaYamlTrustDialog />)
  })
}

describe('OrcaYamlTrustDialog', () => {
  it('tells the user a review command becomes a prompt, not a shell command', async () => {
    await renderTrustDialog({
      scriptKind: 'reviewCommand',
      scriptContent: 'Review {{artifact_url}}'
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('becomes the prompt Orca sends the agent')
    expect(text).not.toContain('runs on your machine')
    expect(text).toContain('Use review command from Repo One?')
  })

  it('still says a setup script runs on your machine', async () => {
    await renderTrustDialog({ scriptKind: 'setup', scriptContent: 'pnpm install' })
    const text = document.body.textContent ?? ''
    expect(text).toContain('runs on your machine')
    expect(text).toContain('Run setup script from Repo One?')
  })

  // Why: the effect and trigger fragments sit on one JSX line and have lost their separating space before.
  it('keeps whitespace between the adjacent description fragments', async () => {
    for (const scriptKind of ['setup', 'issueCommand', 'reviewCommand']) {
      await renderTrustDialog({ scriptKind, scriptContent: 'x' })
      const text = document.body.textContent ?? ''
      expect(text).not.toContain("repository'sorca.yaml")
      expect(text).not.toContain('trustorca')
      expect(text).not.toContain('inorca')
    }
  })
})
