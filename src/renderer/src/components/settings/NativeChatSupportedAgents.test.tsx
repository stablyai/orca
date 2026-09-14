// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isNativeChatSupportedAgent,
  NATIVE_CHAT_SUPPORTED_AGENT_LIST
} from '../../../../shared/native-chat-agent-support'
import type { TuiAgent } from '../../../../shared/tui-agent'
import en from '@/i18n/locales/en.json'
import { i18n } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { NativeChatSupportedAgents } from './NativeChatSupportedAgents'

const EXPECTED_SUPPORTED_AGENTS = [
  'claude',
  'openclaude',
  'codex',
  'grok',
  'omp'
] as const satisfies readonly TuiAgent[]
const SUPPORTED_AGENTS_LABEL_KEY = 'auto.components.settings.NativeChatSupportedAgents.label'

function getRenderedChips(): { agent: string; label: string; role: string }[] {
  const markup = renderToStaticMarkup(<NativeChatSupportedAgents />)
  const container = document.createElement('div')
  container.innerHTML = markup
  return Array.from(container.querySelectorAll('[data-agent]')).map((node) => ({
    agent: node.getAttribute('data-agent') ?? '',
    label: node.getAttribute('aria-label') ?? '',
    role: node.getAttribute('role') ?? ''
  }))
}

describe('NativeChatSupportedAgents', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('keeps the advertised list and support predicate on the independent contract', () => {
    expect(NATIVE_CHAT_SUPPORTED_AGENT_LIST).toEqual(EXPECTED_SUPPORTED_AGENTS)
    for (const entry of getAgentCatalog()) {
      expect(isNativeChatSupportedAgent(entry.id), entry.id).toBe(
        EXPECTED_SUPPORTED_AGENTS.includes(entry.id as (typeof EXPECTED_SUPPORTED_AGENTS)[number])
      )
    }
  })

  it('renders exactly one chip for each supported agent', () => {
    expect(getRenderedChips().map((chip) => chip.agent)).toEqual(EXPECTED_SUPPORTED_AGENTS)
  })

  it('gives each icon an accessible catalog agent name', () => {
    for (const chip of getRenderedChips()) {
      const entry = getAgentCatalog().find((candidate) => candidate.id === chip.agent)
      expect(chip.label).toBe(entry?.label)
      expect(chip.role).toBe('img')
    }
  })

  it('omits agents native chat cannot render, including OpenCode', () => {
    const rendered = getRenderedChips().map((chip) => chip.agent)

    for (const entry of getAgentCatalog()) {
      if (!isNativeChatSupportedAgent(entry.id)) {
        expect(rendered).not.toContain(entry.id)
      }
    }
    expect(rendered).not.toContain('opencode')
  })

  it('keeps the label in the English catalog', () => {
    // Against en.json, not the runtime resource: the renderer only bundles the
    // English entries i18next cannot rebuild from a call site default, and this
    // label's default already spells the same string.
    const value = SUPPORTED_AGENTS_LABEL_KEY.split('.').reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      en
    )

    expect(value).toBe('Supported agents:')
  })

  it('renders the English fallback when the active locale lacks the label key', async () => {
    await i18n.changeLanguage('es')
    expect(i18n.getResource('es', 'translation', SUPPORTED_AGENTS_LABEL_KEY)).toBeUndefined()

    const markup = renderToStaticMarkup(<NativeChatSupportedAgents />)

    expect(markup).toContain('Supported agents:')
  })
})
