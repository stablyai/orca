import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeAuthMethod } from '../../../../shared/types'
import { AddAccountModal, AddAccountModalBody } from './AddAccountModal'

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

function renderFormBody(provider: ClaudeAuthMethod = 'anthropic-api-key'): unknown {
  return AddAccountModalBody({
    step: 'form',
    pickedProvider: provider,
    activeIndex: 0,
    onActiveIndexChange: () => {},
    onPickProvider: () => {},
    onBack: () => {}
  })
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

    // After picking, the form view renders a Back button.
    const formTree = renderFormBody('anthropic-api-key')
    const backButton = findByAriaLabel(formTree, /back/i)
    expect(backButton).not.toBeNull()
    expect(collectText(backButton).toLowerCase()).toMatch(/back/)
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
