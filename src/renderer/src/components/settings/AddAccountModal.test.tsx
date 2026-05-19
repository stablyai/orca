import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthMethod } from '../../../../shared/types'
import { AddAccountModal, AddAccountModalBody } from './AddAccountModal'
import {
  AnthropicApiKeyFormView,
  buildAnthropicApiKeySubmit
} from './provider-forms/AnthropicApiKeyForm'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function collectText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const element = node as ReactElementLike
  return collectText(element.props?.children)
}

function findByAriaLabel(node: unknown, ariaLabel: RegExp | string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (found) {
      return
    }
    const label = entry.props['aria-label']
    if (typeof label !== 'string') {
      return
    }
    if (typeof ariaLabel === 'string') {
      if (label === ariaLabel) {
        found = entry
      }
    } else if (ariaLabel.test(label)) {
      found = entry
    }
  })
  return found
}

// Renders the pick-step body directly (no React state hooks invoked outside
// a render context — the body is stateless when given controlled props).
function renderPickBody(onPick: (p: ClaudeAuthMethod) => void = () => {}): unknown {
  return AddAccountModalBody({
    step: 'pick',
    pickedProvider: null,
    activeIndex: 0,
    onActiveIndexChange: () => {},
    onPickProvider: onPick,
    onBack: () => {}
  })
}

function renderFormBody(
  provider: ClaudeAuthMethod = 'anthropic-api-key',
  onSubmit: (input: unknown) => void = () => {}
): unknown {
  return AddAccountModalBody({
    step: 'form',
    pickedProvider: provider,
    activeIndex: 0,
    onActiveIndexChange: () => {},
    onPickProvider: () => {},
    onBack: () => {},
    onSubmit: onSubmit as never
  })
}

// Renders the API-key form view directly with explicit state so tests can
// inspect the resulting tree without hooks.
function renderApiKeyFormView(overrides: Partial<{
  label: string
  apiKey: string
  showKey: boolean
  error: string | null
  onLabelChange: (v: string) => void
  onApiKeyChange: (v: string) => void
  onToggleShowKey: () => void
  onSubmit: () => void
  onCancel: () => void
}> = {}): unknown {
  return AnthropicApiKeyFormView({
    label: '',
    apiKey: '',
    showKey: false,
    error: null,
    onLabelChange: () => {},
    onApiKeyChange: () => {},
    onToggleShowKey: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    ...overrides
  })
}

function findById(node: unknown, id: string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (found) return
    if (entry.props.id === id) {
      found = entry
    }
  })
  return found
}

describe('AddAccountModal step 1: provider grid', () => {
  it('renders 3 enabled provider cards (oauth, api-key, compat)', () => {
    const tree = renderPickBody()
    const markup = renderToStaticMarkup(tree as React.ReactElement)

    expect(markup).toMatch(/sign in with claude\.ai/i)
    expect(markup).toMatch(/anthropic api key/i)
    expect(markup).toMatch(/anthropic-compatible/i)

    const oauth = findByAriaLabel(tree, /sign in with claude\.ai/i)
    const apiKey = findByAriaLabel(tree, /anthropic api key/i)
    const compat = findByAriaLabel(tree, /anthropic-compatible/i)
    expect(oauth).not.toBeNull()
    expect(apiKey).not.toBeNull()
    expect(compat).not.toBeNull()
    expect(oauth?.props.disabled).toBeFalsy()
    expect(apiKey?.props.disabled).toBeFalsy()
    expect(compat?.props.disabled).toBeFalsy()
  })

  it('clicking the Anthropic API key card advances to a form view (step 2)', () => {
    const onPick = vi.fn()
    const pickTree = renderPickBody(onPick)
    const apiKeyCard = findByAriaLabel(pickTree, /anthropic api key/i)
    expect(apiKeyCard).not.toBeNull()

    const onClick = apiKeyCard?.props.onClick as () => void
    onClick()
    expect(onPick).toHaveBeenCalledWith('anthropic-api-key')

    // After picking, the form view renders an AnthropicApiKeyForm with a
    // wired onCancel prop (which the form's internal "Back" button invokes).
    // Render the stateless view directly to inspect its Back button.
    const back = findByAriaLabel(
      AnthropicApiKeyFormView({
        label: '',
        apiKey: '',
        showKey: false,
        error: null,
        onLabelChange: () => {},
        onApiKeyChange: () => {},
        onToggleShowKey: () => {},
        onSubmit: () => {},
        onCancel: () => {}
      }),
      /^back$/i
    )
    expect(back).not.toBeNull()
    expect(collectText(back).toLowerCase()).toMatch(/back/)
  })

  it('shows Bedrock/Vertex/Azure Foundry cards as disabled with "Coming in P2/P3"', () => {
    const tree = renderPickBody()

    const bedrock = findByAriaLabel(tree, /aws bedrock/i)
    const vertex = findByAriaLabel(tree, /google vertex/i)
    const azure = findByAriaLabel(tree, /azure ai foundry/i)

    expect(bedrock?.props.disabled).toBe(true)
    expect(vertex?.props.disabled).toBe(true)
    expect(azure?.props.disabled).toBe(true)

    expect(collectText(bedrock).toLowerCase()).toMatch(/coming/i)
    expect(collectText(vertex).toLowerCase()).toMatch(/coming/i)
    expect(collectText(azure).toLowerCase()).toMatch(/coming/i)

    // Spec: Bedrock & Azure Foundry → P2, Vertex → P3.
    expect(collectText(bedrock)).toMatch(/P2/)
    expect(collectText(vertex)).toMatch(/P3/)
    expect(collectText(azure)).toMatch(/P2/)
  })

  it('enabled cards form a roving tabindex group with one active stop', () => {
    const tree = renderPickBody()

    const oauth = findByAriaLabel(tree, /sign in with claude\.ai/i)
    const apiKey = findByAriaLabel(tree, /anthropic api key/i)
    const compat = findByAriaLabel(tree, /anthropic-compatible/i)

    // Roving tabindex: exactly one enabled card has tabIndex 0, others have -1.
    const tabIndexes = [oauth, apiKey, compat].map((c) => c?.props.tabIndex)
    const zeros = tabIndexes.filter((t) => t === 0)
    const minusOnes = tabIndexes.filter((t) => t === -1)
    expect(zeros.length).toBe(1)
    expect(minusOnes.length).toBe(2)

    // Enabled cards listen for arrow-key navigation.
    expect(typeof oauth?.props.onKeyDown).toBe('function')
    expect(typeof apiKey?.props.onKeyDown).toBe('function')
    expect(typeof compat?.props.onKeyDown).toBe('function')
  })

  it('the AddAccountModal wrapper renders without throwing', () => {
    // Smoke test the stateful wrapper end-to-end. The Radix Dialog renders
    // through a portal so the picker grid does not appear in the static
    // markup, but the call should not throw — proving the hook wiring is
    // sound.
    expect(() =>
      renderToStaticMarkup(
        <AddAccountModal open onOpenChange={() => {}} onSubmit={vi.fn() as never} />
      )
    ).not.toThrow()
  })
})

describe('AddAccountModal step 2: Anthropic API key form', () => {
  it('renders a Label text input and a password-type API key input', () => {
    const tree = renderApiKeyFormView()

    const labelInput = findById(tree, 'aak-label')
    const keyInput = findById(tree, 'aak-key')

    expect(labelInput).not.toBeNull()
    expect(keyInput).not.toBeNull()
    // Default Label input renders as a plain text input (no explicit type).
    expect(labelInput?.props.type).not.toBe('password')
    expect(keyInput?.props.type).toBe('password')

    // Both inputs have visible <label htmlFor> partners.
    const markup = renderToStaticMarkup(tree as React.ReactElement)
    expect(markup.toLowerCase()).toMatch(/label/)
    expect(markup.toLowerCase()).toMatch(/api key/)
  })

  it('AddAccountModalBody wires the API key form into step 2 for anthropic-api-key', () => {
    // The body returns the form element with onSubmit + onCancel props wired
    // to the parent. We assert wiring shape — the form internals are tested
    // separately via renderApiKeyFormView.
    const parent = vi.fn()
    const tree = renderFormBody('anthropic-api-key', parent)
    const formEl = tree as ReactElementLike
    expect(typeof formEl.props.onSubmit).toBe('function')
    expect(typeof formEl.props.onCancel).toBe('function')
  })

  it('buildAnthropicApiKeySubmit produces the wire-shape payload', () => {
    const result = buildAnthropicApiKeySubmit({ label: 'Work', apiKey: 'sk-ant-abc' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload).toEqual({
        authMethod: 'anthropic-api-key',
        label: 'Work',
        secretFromUser: 'sk-ant-abc'
      })
    }
  })

  it('omits the label field when blank and trims whitespace', () => {
    const result = buildAnthropicApiKeySubmit({ label: '   ', apiKey: '  sk-ant-xyz  ' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.label).toBeUndefined()
      expect(result.payload.secretFromUser).toBe('sk-ant-xyz')
    }
  })

  it('submitting the form with valid inputs flows the payload to the parent onSubmit', () => {
    // Simulate the wiring path: the modal body renders <AnthropicApiKeyForm>,
    // which calls onSubmit with the built payload. We exercise the pure
    // builder here and assert the body wires onSubmit through correctly by
    // invoking the form's onSubmit prop directly.
    const parent = vi.fn()
    const tree = renderFormBody('anthropic-api-key', parent)
    // The body returns an <AnthropicApiKeyForm /> element. Invoke its
    // onSubmit prop with a built payload — this is exactly what the form
    // does internally after validating user input.
    const formEl = tree as ReactElementLike
    const onSubmitProp = formEl.props.onSubmit as (p: unknown) => void
    const built = buildAnthropicApiKeySubmit({ label: 'Work', apiKey: 'sk-ant-abc' })
    expect(built.ok).toBe(true)
    if (built.ok) {
      onSubmitProp(built.payload)
    }
    expect(parent).toHaveBeenCalledWith({
      authMethod: 'anthropic-api-key',
      label: 'Work',
      secretFromUser: 'sk-ant-abc'
    })
  })

  it('empty key surfaces an inline error containing "required"', () => {
    const result = buildAnthropicApiKeySubmit({ label: 'Work', apiKey: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/required/i)
    }
    // And the rendered view shows that error inline when provided.
    const tree = renderApiKeyFormView({ error: 'API key is required.' })
    const markup = renderToStaticMarkup(tree as React.ReactElement)
    expect(markup).toMatch(/required/i)
  })

  it('whitespace-only key is treated as empty and fails validation', () => {
    const result = buildAnthropicApiKeySubmit({ label: '', apiKey: '   ' })
    expect(result.ok).toBe(false)
  })

  it('key input is password by default and the Show button toggles to type=text', () => {
    const masked = renderApiKeyFormView({ showKey: false })
    const revealed = renderApiKeyFormView({ showKey: true })

    expect(findById(masked, 'aak-key')?.props.type).toBe('password')
    expect(findById(revealed, 'aak-key')?.props.type).toBe('text')

    // The toggle button advertises its state via aria-pressed and visible
    // label text alternates between "Show" and "Hide".
    const toggle = findByAriaLabel(masked, /show api key/i)
    expect(toggle).not.toBeNull()
    expect(toggle?.props['aria-pressed']).toBe(false)
    const toggleOn = findByAriaLabel(revealed, /hide api key/i)
    expect(toggleOn).not.toBeNull()
    expect(toggleOn?.props['aria-pressed']).toBe(true)

    // Invoking the toggle handler calls back as expected.
    const onToggle = vi.fn()
    const interactiveTree = renderApiKeyFormView({ showKey: false, onToggleShowKey: onToggle })
    const button = findByAriaLabel(interactiveTree, /show api key/i)
    expect(button).not.toBeNull()
    ;(button?.props.onClick as () => void)()
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('cancel button invokes the back/cancel handler', () => {
    const onCancel = vi.fn()
    const tree = renderApiKeyFormView({ onCancel })
    const back = findByAriaLabel(tree, /^back$/i)
    expect(back).not.toBeNull()
    ;(back?.props.onClick as () => void)()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
