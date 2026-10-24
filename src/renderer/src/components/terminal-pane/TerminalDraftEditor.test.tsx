// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalDraftEditor } from './TerminalDraftEditor'

const beginDesktopTerminalDraft = vi.fn()
const saveDesktopTerminalDraft = vi.fn()
const submitDesktopTerminalDraft = vi.fn()
const releaseDesktopTerminalDraft = vi.fn()

vi.mock('@/runtime/terminal-draft-client', () => ({
  beginDesktopTerminalDraft: (...args: unknown[]) => beginDesktopTerminalDraft(...args),
  saveDesktopTerminalDraft: (...args: unknown[]) => saveDesktopTerminalDraft(...args),
  submitDesktopTerminalDraft: (...args: unknown[]) => submitDesktopTerminalDraft(...args),
  releaseDesktopTerminalDraft: (...args: unknown[]) => releaseDesktopTerminalDraft(...args)
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = false

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.resetAllMocks()
  window.localStorage.clear()
  releaseDesktopTerminalDraft.mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

async function tick(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function renderEditor(getPtyId: () => string | null = () => 'pty-remote'): void {
  root.render(<TerminalDraftEditor recoveryKey="tab:leaf" getPtyId={getPtyId} />)
}

async function openEditor(): Promise<void> {
  await tick()
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open terminal draft editor"]'
  )
  button?.click()
  await tick()
  await tick()
  await tick()
}

function textarea(): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal draft text"]')
}

describe('TerminalDraftEditor', () => {
  it('shows an honest fallback when the agent exposes no draft bridge', async () => {
    beginDesktopTerminalDraft.mockResolvedValue({
      ok: false,
      supported: false,
      reason: 'no_bridge'
    })
    renderEditor()
    await openEditor()
    expect(container.textContent).toContain('does not expose a readable draft')
    expect(textarea()).toBeNull()
  })

  it('edits locally and saves the full text only when asked', async () => {
    beginDesktopTerminalDraft.mockResolvedValue({
      ok: true,
      supported: true,
      adapter: 'pi-editor',
      epoch: 3,
      text: 'line one\nline two\nline three',
      sourceToken: 'token-1'
    })
    saveDesktopTerminalDraft.mockResolvedValue({
      ok: true,
      status: 'applied',
      sourceToken: 'token-2'
    })
    renderEditor()
    await openEditor()
    expect(textarea()?.value).toBe('line one\nline two\nline three')
    expect(saveDesktopTerminalDraft).not.toHaveBeenCalled()

    const field = textarea()!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(field, 'line one\nline two EDITED\nline three')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    const saveButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Save draft to terminal without submitting"]'
    )
    saveButton?.click()
    await tick()
    await tick()
    expect(saveDesktopTerminalDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        ptyId: 'pty-remote',
        epoch: 3,
        baseToken: 'token-1',
        text: 'line one\nline two EDITED\nline three'
      })
    )
    expect(container.textContent).toContain('Saved to terminal')
  })

  it('restores an unsaved local copy after the editor is closed', async () => {
    beginDesktopTerminalDraft.mockResolvedValue({
      ok: true,
      supported: true,
      adapter: 'pi-editor',
      epoch: 4,
      text: 'remote text',
      sourceToken: 'token-1'
    })
    renderEditor()
    await openEditor()
    const field = textarea()!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(field, 'local text')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Close terminal draft editor"]')
      ?.click()
    await tick()
    await openEditor()
    expect(textarea()?.value).toBe('local text')
    expect(container.textContent).toContain('Unsaved local changes')
  })

  it('adopts the conflict token so an explicit keep-mine save can proceed', async () => {
    beginDesktopTerminalDraft.mockResolvedValue({
      ok: true,
      supported: true,
      adapter: 'pi-editor',
      epoch: 5,
      text: 'remote',
      sourceToken: 'token-1'
    })
    saveDesktopTerminalDraft
      .mockResolvedValueOnce({
        ok: false,
        status: 'conflict',
        conflict: { text: 'remote changed', sourceToken: 'token-2' }
      })
      .mockResolvedValueOnce({ ok: true, status: 'applied', sourceToken: 'token-3' })
    renderEditor()
    await openEditor()
    const field = textarea()!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(field, 'my local text')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Save draft to terminal without submitting"]'
      )
      ?.click()
    for (let index = 0; index < 5; index += 1) {
      await tick()
    }
    expect(container.textContent).toContain('The terminal draft was changed elsewhere.')
    const keepButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Keep my draft text"]'
    )
    keepButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    for (let index = 0; index < 20; index += 1) {
      await tick()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const saveAgain = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Save draft to terminal without submitting"]'
    )
    expect(saveAgain).not.toBeNull()
    saveAgain?.click()
    for (let index = 0; index < 5; index += 1) {
      await tick()
    }
    expect(saveDesktopTerminalDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseToken: 'token-2', text: 'my local text' })
    )
  })

  it('offers an explicit takeover and requests it with force', async () => {
    beginDesktopTerminalDraft
      .mockResolvedValueOnce({
        ok: false,
        supported: true,
        reason: 'locked',
        holder: { clientId: 'phone', clientType: 'mobile' }
      })
      .mockResolvedValueOnce({
        ok: true,
        supported: true,
        adapter: 'pi-editor',
        epoch: 6,
        text: 'remote after takeover',
        sourceToken: 'token-takeover'
      })
    renderEditor()
    await openEditor()
    expect(container.textContent).toContain('Another device is editing')
    expect(container.textContent).toContain('phone')
    container.querySelector<HTMLButtonElement>('button[aria-label="Take over editing"]')?.click()
    for (let index = 0; index < 5; index += 1) {
      await tick()
    }
    expect(beginDesktopTerminalDraft).toHaveBeenLastCalledWith(
      'pty-remote',
      expect.any(String),
      true
    )
    expect(textarea()?.value).toBe('remote after takeover')
  })

  it('keeps dirty local text when Reload is used', async () => {
    beginDesktopTerminalDraft.mockResolvedValue({
      ok: true,
      supported: true,
      adapter: 'pi-editor',
      epoch: 7,
      text: 'remote',
      sourceToken: 'token-reload'
    })
    renderEditor()
    await openEditor()
    const field = textarea()!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(field, 'local edit')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Reload the terminal draft"]')
      ?.click()
    for (let index = 0; index < 6; index += 1) {
      await tick()
    }
    expect(textarea()?.value).toBe('local edit')
    expect(container.textContent).toContain('Restored your unsaved local copy')
  })
})
