import { describe, expect, it } from 'vitest'
import type { CustomTuiAgent } from '../../../shared/types'
import { buildAgentCatalog, resolveCustomAgentIconSource } from './agent-catalog'

describe('buildAgentCatalog', () => {
  it('adds ready custom agents after built-ins', () => {
    const custom: CustomTuiAgent = {
      id: 'custom:wrapper-abc123',
      label: 'Wrapper CLI',
      command: 'wrapper --profile dev',
      promptInjectionMode: 'stdin-after-start'
    }

    const catalog = buildAgentCatalog([custom])

    expect(catalog.at(-1)).toMatchObject({
      id: 'custom:wrapper-abc123',
      label: 'Wrapper CLI',
      cmd: 'wrapper --profile dev',
      isCustom: true
    })
  })

  it('keeps incomplete custom agents out of launch catalogs', () => {
    const catalog = buildAgentCatalog([
      {
        id: 'custom:empty-abc123',
        label: 'Empty CLI',
        command: '   ',
        promptInjectionMode: 'stdin-after-start'
      }
    ])

    expect(catalog.some((agent) => agent.id === 'custom:empty-abc123')).toBe(false)
  })

  it('borrows iconSourceId when a custom preset wraps a known built-in', () => {
    const catalog = buildAgentCatalog([
      {
        id: 'custom:codex-wrap-abc123',
        label: 'Codex Work',
        command: 'codex --profile work',
        promptInjectionMode: 'stdin-after-start'
      }
    ])

    expect(catalog.at(-1)).toMatchObject({
      id: 'custom:codex-wrap-abc123',
      iconSourceId: 'codex'
    })
  })

  it('inherits faviconDomain from the matching built-in when none is set', () => {
    const catalog = buildAgentCatalog([
      {
        id: 'custom:grok-abc123',
        label: 'Grok Wrap',
        command: 'grok --foo',
        promptInjectionMode: 'stdin-after-start'
      }
    ])

    expect(catalog.at(-1)).toMatchObject({
      iconSourceId: 'grok',
      faviconDomain: 'x.ai'
    })
  })

  it('uses the user-provided detectCmd to resolve the icon source', () => {
    const source = resolveCustomAgentIconSource({
      command: 'sh -c "wrapper.sh"',
      detectCmd: 'codex'
    })

    expect(source?.id).toBe('codex')
  })

  it('returns no icon source when the launch command is unfamiliar', () => {
    const source = resolveCustomAgentIconSource({
      command: 'wrapper --profile dev'
    })

    expect(source).toBeUndefined()
  })
})
