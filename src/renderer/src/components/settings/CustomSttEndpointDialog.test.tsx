// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomSttEndpointReachability } from '../../../../shared/speech-types'
import { CustomSttEndpointDialog, type CustomSttEndpointTestState } from './CustomSttEndpointDialog'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => values[k] ?? '') : fallback
}))

type RenderArgs = {
  configured?: boolean
  baseUrlDraft?: string
  modelDraft?: string
  modelSuggestions?: string[]
  discovering?: boolean
  reachability?: CustomSttEndpointReachability
  testResult?: CustomSttEndpointTestState | null
  pending?: boolean
  testing?: boolean
  onSave?: (options?: { allowInvalid?: boolean }) => void
  onClear?: () => void
  onTest?: () => void
  onCancel?: () => void
}

function renderDialog(args: RenderArgs = {}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <CustomSttEndpointDialog
        open
        configured={args.configured ?? false}
        baseUrlDraft={args.baseUrlDraft ?? ''}
        modelDraft={args.modelDraft ?? ''}
        modelSuggestions={args.modelSuggestions ?? []}
        discovering={args.discovering ?? false}
        languageDraft=""
        apiKeyDraft=""
        apiKeyConfigured={false}
        pending={args.pending ?? false}
        testing={args.testing ?? false}
        reachability={args.reachability ?? 'unknown'}
        testResult={args.testResult ?? null}
        onOpenChange={vi.fn()}
        onBaseUrlDraftChange={vi.fn()}
        onModelDraftChange={vi.fn()}
        onLanguageDraftChange={vi.fn()}
        onApiKeyDraftChange={vi.fn()}
        onSave={args.onSave ?? vi.fn()}
        onClear={args.onClear ?? vi.fn()}
        onTest={args.onTest ?? vi.fn()}
        onCancel={args.onCancel ?? vi.fn()}
      />
    )
  })
  return { container, root }
}

function buttonByName(name: string): HTMLButtonElement | null {
  return (
    Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === name
    ) ?? null
  )
}

describe('CustomSttEndpointDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('disables Save until both a base URL and a model are entered', () => {
    const { root } = renderDialog({ baseUrlDraft: 'http://h/v1' })
    expect(buttonByName('Save')?.disabled).toBe(true)
    root.unmount()
  })

  it('enables Test with only a base URL (no model required)', () => {
    const { root } = renderDialog({ baseUrlDraft: 'http://h/v1' })
    expect(buttonByName('Test')?.disabled).toBe(false)
    root.unmount()
  })

  it('enables Save when both fields are present', () => {
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      modelDraft: 'large-v3'
    })
    expect(buttonByName('Save')?.disabled).toBe(false)
    root.unmount()
  })

  it('blocks Save and offers a Save-anyway escape hatch on a server rejection', () => {
    const onSave = vi.fn()
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      modelDraft: 'large-v3',
      testResult: { ok: false, outcome: 'rejected', detail: 'bad language' },
      onSave
    })

    expect(buttonByName('Save')?.disabled).toBe(true)
    const escape = buttonByName('Save anyway (advanced)')
    expect(escape).not.toBeNull()

    act(() => {
      escape!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSave).toHaveBeenCalledWith({ allowInvalid: true })
    root.unmount()
  })

  it('keeps Save enabled when the server is merely unreachable', () => {
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      modelDraft: 'large-v3',
      testResult: { ok: false, outcome: 'transport', detail: 'offline' }
    })

    expect(buttonByName('Save')?.disabled).toBe(false)
    expect(buttonByName('Save anyway (advanced)')).toBeNull()
    root.unmount()
  })

  it('shows the Unreachable mark for an unreachable endpoint', () => {
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      reachability: 'unreachable'
    })
    expect(document.body.querySelector('[aria-label="Endpoint unreachable"]')).not.toBeNull()
    root.unmount()
  })

  it('shows the Reachable mark with a green tick for a reachable endpoint', () => {
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      reachability: 'reachable'
    })
    const mark = document.body.querySelector('[aria-label="Endpoint reachable"]')
    expect(mark).not.toBeNull()
    expect(mark?.className).toContain('text-status-success')
    root.unmount()
  })

  it('shows a checking spinner while discovering', () => {
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      discovering: true
    })
    expect(document.body.querySelector('[aria-label="Checking endpoint"]')).not.toBeNull()
    root.unmount()
  })

  it('shows Disconnect only when an endpoint is already configured', () => {
    const unconfigured = renderDialog({ configured: false })
    expect(buttonByName('Disconnect')).toBeNull()
    unconfigured.root.unmount()

    const configured = renderDialog({ configured: true })
    expect(buttonByName('Disconnect')).not.toBeNull()
    configured.root.unmount()
  })

  it('calls onCancel when Cancel is pressed', () => {
    const onCancel = vi.fn()
    const { root } = renderDialog({ onCancel })

    act(() => {
      buttonByName('Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledOnce()
    root.unmount()
  })

  it('renders discovered model suggestions in the list', () => {
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      modelSuggestions: ['large-v3', 'small']
    })
    const modelInput = document.body.querySelector<HTMLInputElement>('#custom-stt-model')
    act(() => {
      // React listens for focus via focusin delegation.
      modelInput?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('large-v3')
    expect(document.body.textContent).toContain('small')
    root.unmount()
  })

  it('shows the test result detail', () => {
    const { root } = renderDialog({
      baseUrlDraft: 'http://h/v1',
      testResult: { ok: true, outcome: 'ok', detail: 'Reachable (HTTP 200).' }
    })
    expect(document.body.textContent).toContain('Reachable (HTTP 200).')
    root.unmount()
  })
})
