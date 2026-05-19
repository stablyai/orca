import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthMethod } from '../../../../shared/types'
import { AddAccountModal, AddAccountModalBody, AddAccountModalFormView } from './AddAccountModal'
import {
  AnthropicApiKeyFormView,
  buildAnthropicApiKeySubmit
} from './provider-forms/AnthropicApiKeyForm'
import {
  AnthropicCompatFormView,
  buildAnthropicCompatSubmit
} from './provider-forms/AnthropicCompatForm'
import type { AnthropicCompatPreset } from '../../../../shared/types'

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

  it('shows Bedrock/Vertex cards as disabled with "Coming in P2/P3"', () => {
    // Azure Foundry was enabled in P2 (Task 16) — only Bedrock + Vertex remain
    // as stub cards. Bedrock → P2 (later), Vertex → P3.
    const tree = renderPickBody()

    const bedrock = findByAriaLabel(tree, /aws bedrock/i)
    const vertex = findByAriaLabel(tree, /google vertex/i)

    expect(bedrock?.props.disabled).toBe(true)
    expect(vertex?.props.disabled).toBe(true)

    expect(collectText(bedrock).toLowerCase()).toMatch(/coming/i)
    expect(collectText(vertex).toLowerCase()).toMatch(/coming/i)

    expect(collectText(bedrock)).toMatch(/P2/)
    expect(collectText(vertex)).toMatch(/P3/)
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
    // P2: the body returns <AddAccountModalFormView /> which dispatches by
    // `picked` and wires onSubmit/onBack through to the parent. We assert
    // wiring shape — form internals are tested separately via renderApiKeyFormView.
    const parent = vi.fn()
    const tree = renderFormBody('anthropic-api-key', parent)
    const formEl = tree as ReactElementLike
    expect(typeof formEl.props.onSubmit).toBe('function')
    expect(typeof formEl.props.onBack).toBe('function')
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

// Helpers + tests for the Anthropic-compat provider form (Task 15).
function renderCompatFormView(
  overrides: Partial<{
    preset: AnthropicCompatPreset
    token: string
    label: string
    baseUrl: string
    error: string | null
    onChangePreset: (p: AnthropicCompatPreset) => void
    onChangeToken: (v: string) => void
    onChangeLabel: (v: string) => void
    onChangeBaseUrl: (v: string) => void
    onSubmit: () => void
    onCancel: () => void
  }> = {}
): unknown {
  return AnthropicCompatFormView({
    preset: 'zai',
    token: '',
    label: '',
    baseUrl: '',
    error: null,
    onChangePreset: () => {},
    onChangeToken: () => {},
    onChangeLabel: () => {},
    onChangeBaseUrl: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    ...overrides
  })
}

function findAllByRole(node: unknown, role: string): ReactElementLike[] {
  const out: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.props.role === role) {
      out.push(entry)
    }
  })
  return out
}

function findByTestId(node: unknown, testId: string): ReactElementLike | null {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (found) return
    if (entry.props['data-testid'] === testId) {
      found = entry
    }
  })
  return found
}

describe('AddAccountModal step 2: Anthropic-compat form', () => {
  it('renders 4 preset segmented-control options (z.ai, Kimi, MiniMax, Custom)', () => {
    const tree = renderCompatFormView()
    const tabs = findAllByRole(tree, 'tab')
    expect(tabs).toHaveLength(4)
    const labels = tabs.map((t) => collectText(t).toLowerCase())
    expect(labels.some((l) => l.includes('z.ai'))).toBe(true)
    expect(labels.some((l) => l.includes('kimi'))).toBe(true)
    expect(labels.some((l) => l.includes('minimax'))).toBe(true)
    expect(labels.some((l) => l.includes('custom'))).toBe(true)
  })

  it('exactly one preset tab is aria-selected at a time', () => {
    const tree = renderCompatFormView({ preset: 'kimi' })
    const tabs = findAllByRole(tree, 'tab')
    const selected = tabs.filter((t) => t.props['aria-selected'] === true)
    expect(selected).toHaveLength(1)
    expect(collectText(selected[0]).toLowerCase()).toMatch(/kimi/)
  })

  it('non-custom presets show the baked baseUrl as read-only context (no input)', () => {
    for (const preset of ['zai', 'kimi', 'minimax'] as const) {
      const tree = renderCompatFormView({ preset })
      const baked = findByTestId(tree, 'baked-base-url')
      expect(baked).not.toBeNull()
      // Baked URL is shown inline, no editable baseUrl input.
      expect(findById(tree, 'acf-baseurl')).toBeNull()
    }
  })

  it('custom preset reveals a baseUrl input and hides the baked context', () => {
    const tree = renderCompatFormView({ preset: 'custom' })
    expect(findByTestId(tree, 'baked-base-url')).toBeNull()
    const baseUrlInput = findById(tree, 'acf-baseurl')
    expect(baseUrlInput).not.toBeNull()
  })

  it('buildAnthropicCompatSubmit returns payload without baseUrl for non-custom presets', () => {
    const result = buildAnthropicCompatSubmit({
      preset: 'zai',
      token: 'zai-tok',
      label: 'GLM'
    })
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result).toEqual({
        authMethod: 'anthropic-compat',
        label: 'GLM',
        secretFromUser: 'zai-tok',
        providerConfig: { preset: 'zai' }
      })
    }
  })

  it('buildAnthropicCompatSubmit includes baseUrl when preset is custom', () => {
    const result = buildAnthropicCompatSubmit({
      preset: 'custom',
      token: 'tok',
      label: 'X',
      baseUrl: 'https://example.com'
    })
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result).toEqual({
        authMethod: 'anthropic-compat',
        label: 'X',
        secretFromUser: 'tok',
        providerConfig: { preset: 'custom', baseUrl: 'https://example.com' }
      })
    }
  })

  it('custom preset with empty baseUrl produces an inline error', () => {
    const result = buildAnthropicCompatSubmit({
      preset: 'custom',
      token: 'tok',
      label: '',
      baseUrl: '   '
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.toLowerCase()).toMatch(/base url/)
    }
  })

  it('empty token produces an inline error', () => {
    const result = buildAnthropicCompatSubmit({
      preset: 'zai',
      token: '   ',
      label: ''
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.toLowerCase()).toMatch(/token|required/)
    }
    // And the rendered view surfaces an error message when provided.
    const tree = renderCompatFormView({ error: 'Provider auth token is required.' })
    const markup = renderToStaticMarkup(tree as React.ReactElement)
    expect(markup).toMatch(/required/i)
  })

  it('omits the label field when blank and trims whitespace on token + baseUrl', () => {
    const result = buildAnthropicCompatSubmit({
      preset: 'custom',
      token: '  tok-xyz  ',
      label: '   ',
      baseUrl: '  https://proxy.example.com  '
    })
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.label).toBeUndefined()
      expect(result.secretFromUser).toBe('tok-xyz')
      expect(result.providerConfig.baseUrl).toBe('https://proxy.example.com')
    }
  })

  it('AddAccountModalBody wires the compat form into step 2 for anthropic-compat', () => {
    const parent = vi.fn()
    const tree = renderFormBody('anthropic-compat', parent)
    const formEl = tree as ReactElementLike
    // Wire-up: the body returns <AddAccountModalFormView /> with onSubmit + onBack.
    expect(typeof formEl.props.onSubmit).toBe('function')
    expect(typeof formEl.props.onBack).toBe('function')
  })

  it('submitting valid input fires onSubmit with the built payload', () => {
    const parent = vi.fn()
    const tree = renderFormBody('anthropic-compat', parent)
    const formEl = tree as ReactElementLike
    const onSubmitProp = formEl.props.onSubmit as (p: unknown) => void
    const built = buildAnthropicCompatSubmit({
      preset: 'minimax',
      token: 'mm-token',
      label: 'M2'
    })
    expect('error' in built).toBe(false)
    if (!('error' in built)) {
      onSubmitProp(built)
    }
    expect(parent).toHaveBeenCalledWith({
      authMethod: 'anthropic-compat',
      label: 'M2',
      secretFromUser: 'mm-token',
      providerConfig: { preset: 'minimax' }
    })
  })

  it('cancel button invokes the back/cancel handler', () => {
    const onCancel = vi.fn()
    const tree = renderCompatFormView({ onCancel })
    const back = findByAriaLabel(tree, /^back$/i) ?? null
    // The compat form's Back button is a plain Button with text "Back"; if
    // aria-label is absent, fall back to scanning button text.
    let backNode: ReactElementLike | null = back
    if (!backNode) {
      visit(tree, (entry) => {
        if (backNode) return
        const text = collectText(entry).trim().toLowerCase()
        const onClick = entry.props.onClick
        if (text === 'back' && typeof onClick === 'function' && entry.props.type === 'button') {
          backNode = entry
        }
      })
    }
    expect(backNode).not.toBeNull()
    ;(backNode?.props.onClick as () => void)()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('AddAccountModal — Azure AI Foundry (P2)', () => {
  it('Foundry card is enabled', () => {
    const markup = renderToStaticMarkup(
      <AddAccountModal open onOpenChange={() => {}} onSubmit={() => {}} />
    )
    // The Radix Dialog renders through a portal so the static markup is empty,
    // but the picker grid is rendered when we call the body directly. Assert
    // there: card present + not disabled.
    const tree = renderPickBody()
    const foundry = findByAriaLabel(tree, 'Azure AI Foundry')
    expect(foundry).not.toBeNull()
    expect(foundry?.props.disabled).toBeFalsy()
    // Sanity: top-level static render still throws nothing.
    expect(markup).toBeDefined()
  })

  it('AddAccountModalFormView renders AzureFoundryForm when picked is azure-foundry', () => {
    const tree = (
      <AddAccountModalFormView
        picked="azure-foundry"
        onSubmit={() => {}}
        onBack={() => {}}
        onValidate={async () => ({ ok: true })}
      />
    )
    const markup = renderToStaticMarkup(tree as React.ReactElement)
    expect(markup).toMatch(/aria-label="Resource"/)
  })

  it('validateInputViaIpc forwards the input to claudeAccounts.validateInput and returns ok', async () => {
    // Mock the renderer's window.api surface for this test. The helper
    // bridges the form's `{ ok, message? }` shape onto the IPC's locked
    // `{ ok: true } | { ok: false, reason, rescueHint? }` contract.
    const validateInputMock = vi.fn(async () => ({ ok: true } as const))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = {
      api: { claudeAccounts: { validateInput: validateInputMock } }
    }

    const { validateInputViaIpc } = await import('./AddAccountModal')
    const input = {
      authMethod: 'azure-foundry' as const,
      label: 'probe',
      secretFromUser: 'k',
      providerConfig: { resource: 'res', useEntraId: false as const }
    }
    const result = await validateInputViaIpc(input)
    expect(validateInputMock).toHaveBeenCalledWith(input)
    expect(result).toEqual({ ok: true, message: undefined })
  })

  it('validateInputViaIpc maps an IPC failure to { ok: false, message: reason }', async () => {
    const validateInputMock = vi.fn(async () => ({
      ok: false as const,
      reason: 'API key invalid or revoked.',
      rescueHint: 'Generate a new key.'
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = {
      api: { claudeAccounts: { validateInput: validateInputMock } }
    }

    const { validateInputViaIpc } = await import('./AddAccountModal')
    const result = await validateInputViaIpc({
      authMethod: 'anthropic-api-key',
      secretFromUser: 'bad'
    })
    expect(result).toEqual({ ok: false, message: 'API key invalid or revoked.' })
  })
})
