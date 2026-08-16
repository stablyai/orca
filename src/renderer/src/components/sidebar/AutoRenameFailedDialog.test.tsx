// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoRenameFailedDialog } from './AutoRenameFailedDialog'

const getBranchRenameFailureOutput =
  vi.fn<(args: { worktreeId: string }) => Promise<string | null>>()
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = {
    worktrees: { getBranchRenameFailureOutput },
    ui: { writeClipboardText }
  }
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

const EXCERPT_ERROR = 'Pi CLI command failed with code 1: No API key found for github-copilot.'

async function renderDialog(error = EXCERPT_ERROR): Promise<void> {
  await act(async () => {
    root.render(
      <AutoRenameFailedDialog
        open
        onOpenChange={() => {}}
        worktreeId="wt-1"
        worktreeName="staghorn"
        error={error}
      />
    )
  })
}

describe('AutoRenameFailedDialog full output', () => {
  it('shows the full CLI output fetched from main when available', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(
      'Pi exited with code 1.\n\n[stderr]\nNo API key found for github-copilot.\nUse /login to log in.'
    )
    await renderDialog()
    expect(getBranchRenameFailureOutput).toHaveBeenCalledWith({ worktreeId: 'wt-1' })
    expect(document.body.textContent).toContain('[stderr]')
    expect(document.body.textContent).toContain('Use /login to log in.')
  })

  it('falls back to the persisted excerpt when main holds no capture', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(null)
    await renderDialog()
    expect(document.body.textContent).toContain(EXCERPT_ERROR)
  })

  it('falls back to the persisted excerpt when the fetch rejects', async () => {
    getBranchRenameFailureOutput.mockRejectedValueOnce(new Error('ipc unavailable'))
    await renderDialog()
    expect(document.body.textContent).toContain(EXCERPT_ERROR)
  })

  it('refetches full output when a retry changes the persisted error', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce('first run full output')
    await renderDialog('first run excerpt')
    expect(document.body.textContent).toContain('first run full output')

    getBranchRenameFailureOutput.mockResolvedValueOnce('second run full output')
    await renderDialog('second run excerpt')

    expect(getBranchRenameFailureOutput).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('second run full output')
    expect(document.body.textContent).not.toContain('first run full output')
  })
})

// Why: happy-dom does no intrinsic sizing, so assert the two declarations that
// keep an unbroken token from widening DialogContent's grid column instead.
describe('AutoRenameFailedDialog unbroken output containment', () => {
  it('keeps the output surface shrinkable and breakable mid-token', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(`{"error":"${'A'.repeat(1000)}"}`)
    await renderDialog()

    const dialog = document.querySelector('[role="dialog"]')
    const output = dialog?.querySelector('pre')
    expect(output).toBeTruthy()
    expect(output?.textContent).toContain('A'.repeat(1000))

    // `break-words` (overflow-wrap: break-word) wraps painted text but leaves
    // min-content at the full token width; only `anywhere` shrinks it.
    expect(output?.className).toContain('[overflow-wrap:anywhere]')
    expect(output?.className).not.toContain('break-words')

    // DialogContent is a grid, so its child needs min-w-0 to shrink below min-content.
    const gridChild = Array.from(dialog?.children ?? []).find((child) =>
      child.contains(output ?? null)
    )
    expect(gridChild?.className).toContain('min-w-0')
  })
})
