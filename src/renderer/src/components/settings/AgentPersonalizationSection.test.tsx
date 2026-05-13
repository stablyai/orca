import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { AgentPersonalizationSection } from './AgentPersonalizationSection'

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

function findTextareaByPlaceholder(node: unknown, placeholder: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === 'textarea' && entry.props.placeholder === placeholder) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`textarea not found: ${placeholder}`)
  }
  return found
}

const detectedAgents: AgentCatalogEntry[] = [
  {
    id: 'claude',
    label: 'Claude',
    cmd: 'claude',
    homepageUrl: 'https://example.com/claude'
  }
]

function buildSettings(
  agentPersonalizationPrompts: GlobalSettings['agentPersonalizationPrompts'] = {}
): GlobalSettings {
  return {
    personalizationPrompt: 'Shared prompt',
    personalizationPromptMode: 'per-agent',
    agentPersonalizationPrompts
  } as GlobalSettings
}

describe('AgentPersonalizationSection', () => {
  it('trims per-agent prompt overrides before persisting them', () => {
    const updateSettings = vi.fn()
    const element = AgentPersonalizationSection({
      settings: buildSettings(),
      updateSettings,
      detectedAgents
    })

    const textarea = findTextareaByPlaceholder(element, 'Leave blank to use the shared prompt.')
    ;(textarea.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '  Keep changes scoped.  ' }
    })

    expect(updateSettings).toHaveBeenCalledWith({
      agentPersonalizationPrompts: {
        claude: 'Keep changes scoped.'
      }
    })
  })

  it('removes a per-agent prompt override when the edited value trims to blank', () => {
    const updateSettings = vi.fn()
    const element = AgentPersonalizationSection({
      settings: buildSettings({ claude: 'Existing prompt' }),
      updateSettings,
      detectedAgents
    })

    const textarea = findTextareaByPlaceholder(element, 'Leave blank to use the shared prompt.')
    ;(textarea.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '   ' }
    })

    expect(updateSettings).toHaveBeenCalledWith({
      agentPersonalizationPrompts: {}
    })
  })
})
