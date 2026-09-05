import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { aiVaultSearchUnconfiguredHint, AiVaultSearchField } from './AiVaultSearchField'

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

function findByAriaLabel(node: unknown, label: string): ReactElementLike {
  let match: ReactElementLike | undefined
  visit(node, (entry) => {
    if (entry.props['aria-label'] === label) {
      match = entry
    }
  })
  if (!match) {
    throw new Error(`element not found: ${label}`)
  }
  return match
}

function buttonByLabel(markup: string, label: string): string {
  const button = [...markup.matchAll(/<button\b[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .find((entry) => entry.includes(`aria-label="${label}"`))
  if (!button) {
    throw new Error(`button not found: ${label}`)
  }
  return button
}

function hasDisabledAttribute(markup: string): boolean {
  return markup.includes(' disabled=""') || markup.includes('aria-disabled="true"')
}

function fieldProps(
  overrides: Partial<Parameters<typeof AiVaultSearchField>[0]> = {}
): Parameters<typeof AiVaultSearchField>[0] {
  return {
    query: 'linux pairing',
    loading: false,
    aiLoading: false,
    usedModel: false,
    aiAgentConfigured: true,
    searchScope: 'full',
    rgLoading: false,
    rgHitCount: null,
    onQueryChange: vi.fn(),
    onSearchScopeChange: vi.fn(),
    onAiSearch: vi.fn(),
    ...overrides
  }
}

function renderField(overrides: Partial<Parameters<typeof AiVaultSearchField>[0]> = {}): string {
  return renderToStaticMarkup(<AiVaultSearchField {...fieldProps(overrides)} />)
}

describe('AiVaultSearchField', () => {
  it('filters the in-panel list as the user types and does not start AI search', () => {
    const onQueryChange = vi.fn()
    const onAiSearch = vi.fn()
    const tree = AiVaultSearchField(
      fieldProps({
        query: '',
        onQueryChange,
        onAiSearch
      })
    )

    const input = findByAriaLabel(tree, 'Search sessions')
    expect(input.props.placeholder).toBe('Search sessions')
    ;(input.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'linux pairing' }
    })

    expect(onQueryChange).toHaveBeenCalledWith('linux pairing')
    expect(onAiSearch).not.toHaveBeenCalled()
  })

  it('renders a commit-gen-style button that starts AI search', () => {
    const onAiSearch = vi.fn()
    const tree = AiVaultSearchField(fieldProps({ onAiSearch }))

    const markup = renderField({ onAiSearch })
    const button = buttonByLabel(markup, 'Search sessions with AI')
    expect(hasDisabledAttribute(button)).toBe(false)
    expect(button).toContain('Search with AI')
    expect(button).toContain('lucide-sparkles')

    const aiButton = findByAriaLabel(tree, 'Search sessions with AI')
    ;(aiButton.props.onClick as () => void)()
    expect(onAiSearch).toHaveBeenCalledTimes(1)
  })

  it('lets Enter submit AI search when the field is focused', () => {
    const onAiSearch = vi.fn()
    const tree = AiVaultSearchField(fieldProps({ onAiSearch }))

    const input = findByAriaLabel(tree, 'Search sessions')
    const preventDefault = vi.fn()
    ;(
      input.props.onKeyDown as (event: {
        key: string
        preventDefault: () => void
        nativeEvent: { isComposing: boolean }
      }) => void
    )({
      key: 'Enter',
      preventDefault,
      nativeEvent: { isComposing: false }
    })

    expect(preventDefault).toHaveBeenCalled()
    expect(onAiSearch).toHaveBeenCalledTimes(1)
  })

  it('disables AI search with the Source Control AI hint when rename AI is unconfigured', () => {
    const onAiSearch = vi.fn()
    const markup = renderField({
      aiAgentConfigured: false,
      onAiSearch
    })
    const button = buttonByLabel(markup, 'Search sessions with AI')
    expect(hasDisabledAttribute(button)).toBe(true)
    expect(button).toContain('Pick an agent in Settings')
    expect(button).toContain('Source Control AI')
    expect(aiVaultSearchUnconfiguredHint()).toContain('Source Control AI')

    const tree = AiVaultSearchField(
      fieldProps({
        aiAgentConfigured: false,
        onAiSearch
      })
    )
    const input = findByAriaLabel(tree, 'Search sessions')
    ;(
      input.props.onKeyDown as (event: {
        key: string
        preventDefault: () => void
        nativeEvent: { isComposing: boolean }
      }) => void
    )({
      key: 'Enter',
      preventDefault: vi.fn(),
      nativeEvent: { isComposing: false }
    })
    expect(onAiSearch).not.toHaveBeenCalled()
  })

  it('ignores Enter while an IME composition is active', () => {
    const onAiSearch = vi.fn()
    const tree = AiVaultSearchField(fieldProps({ onAiSearch }))
    const input = findByAriaLabel(tree, 'Search sessions')
    ;(
      input.props.onKeyDown as (event: {
        key: string
        preventDefault: () => void
        nativeEvent: { isComposing: boolean }
      }) => void
    )({
      key: 'Enter',
      preventDefault: vi.fn(),
      nativeEvent: { isComposing: true }
    })
    expect(onAiSearch).not.toHaveBeenCalled()
  })

  it('exposes a Search in control that includes Full text and Without tools', () => {
    const markup = renderField()
    expect(markup).toContain('aria-label="Search in"')
    expect(markup).toContain('Full text')
    expect(markup).toContain('Without tools')
    expect(markup).toContain('Title')
    expect(markup).toContain('Summary')
    expect(markup).toContain('Errors')
  })

  it('spins and disables the AI button while generating', () => {
    const markup = renderField({ aiLoading: true })
    const button = buttonByLabel(markup, 'Search sessions with AI')
    expect(hasDisabledAttribute(button)).toBe(true)
    expect(button).toContain('aria-busy="true"')
    expect(button).toContain('lucide-refresh-cw')
    expect(button).toContain('Searching')
  })
})
