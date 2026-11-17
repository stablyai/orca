import { describe, expect, it } from 'vitest'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_CLOUD_IMAGE_AGENTS } from '../../../../shared/hosted-sandbox/orca-cloud-image-agents'
import { resolveQuickWorkspaceAgentSelection } from '@/lib/workspace/creation/quick-workspace-agent-selection'
import {
  ORCA_CLOUD_AGENT_IDS,
  orcaCloudAgentMenuModel,
  orcaCloudAgentSelection,
  pickOrcaCloudAgent
} from './orca-cloud-agent-picker'

describe('pickOrcaCloudAgent', () => {
  it('keeps a default the image ships', () => {
    expect(pickOrcaCloudAgent('gemini')).toBe('gemini')
    expect(pickOrcaCloudAgent('copilot')).toBe('copilot')
  })

  it('falls back to the cloud default for an agent the image does not ship', () => {
    expect(pickOrcaCloudAgent('aider')).toBe('claude')
    expect(pickOrcaCloudAgent('goose')).toBe('claude')
    expect(pickOrcaCloudAgent(undefined)).toBe('claude')
    expect(pickOrcaCloudAgent(null)).toBe('claude')
  })

  it('keeps Blank Terminal as the default when the user chose it', () => {
    expect(pickOrcaCloudAgent('blank')).toBeNull()
  })

  it('skips disabled agents, staying inside the image', () => {
    expect(pickOrcaCloudAgent('gemini', ['gemini'])).toBe('claude')
    expect(pickOrcaCloudAgent('aider', ['claude'])).toBe('codex')
    expect(pickOrcaCloudAgent('aider', [...ORCA_CLOUD_IMAGE_AGENTS])).toBeNull()
  })
})

describe('orcaCloudAgentMenuModel', () => {
  it('names no host, so per-agent setup reads the built-in catalog, not this computer', () => {
    const settings = { agentDefaultArgs: { claude: '--verbose' } }
    const context = orcaCloudAgentMenuModel(settings).pickerContext
    expect(parseExecutionHostId(context?.executionHostId)).toBeNull()
    expect(context?.settings).toBe(settings)
  })

  it('lists exactly the image agents, default first, with a chat where the agent has one', () => {
    const model = orcaCloudAgentMenuModel({ defaultTuiAgent: 'opencode' })
    expect(model.state).toBe('settled')
    expect(model.rows.find((row) => row.agent === 'claude')).toEqual({
      kind: 'cli',
      agent: 'claude',
      chat: true
    })
    expect(model.rows.find((row) => row.agent === 'gemini')).toEqual({
      kind: 'cli',
      agent: 'gemini'
    })
    expect(model.rows.map((row) => row.agent)).toEqual([
      'opencode',
      'claude',
      'codex',
      'copilot',
      'gemini',
      'cursor'
    ])
    expect(new Set(model.rows.map((row) => row.agent))).toEqual(new Set(ORCA_CLOUD_IMAGE_AGENTS))
    expect(model.detection.detectedIds).toEqual([...ORCA_CLOUD_IMAGE_AGENTS])
    expect(model.defaultTuiAgent).toBe('opencode')
  })

  it('omits agents the user disabled and ignores a local-only default', () => {
    const model = orcaCloudAgentMenuModel({
      defaultTuiAgent: 'aider',
      disabledTuiAgents: ['codex']
    })
    const agents = model.rows.map((row) => row.agent)
    expect(agents).not.toContain('codex')
    expect(agents).not.toContain('aider')
    expect(agents).toHaveLength(ORCA_CLOUD_IMAGE_AGENTS.length - 1)
  })
})

describe('orcaCloudAgentSelection', () => {
  it('honours a picked chat or terminal, read from the image rather than this computer', () => {
    expect(orcaCloudAgentSelection('claude', 'chat', {})).toMatchObject({
      ready: true,
      cli: false,
      choice: { agent: 'claude', route: 'structured-native-chat', requestedSurface: 'chat' }
    })
    expect(orcaCloudAgentSelection('claude', 'terminal', {})).toMatchObject({
      cli: true,
      choice: { route: 'terminal-tui', requestedSurface: 'terminal' }
    })
  })

  it('keeps an agent with no chat a plain terminal', () => {
    expect(orcaCloudAgentSelection('gemini', 'chat', {})).toMatchObject({
      cli: false,
      choice: { route: 'terminal-tui' }
    })
  })

  it('leaves an unpicked surface to the create, which reads the chat preference', () => {
    expect(
      orcaCloudAgentSelection('claude', undefined, {}).choice?.requestedSurface
    ).toBeUndefined()
  })
})

describe('Orca Cloud composer selection repair', () => {
  it('repairs a local-only pick to the cloud default instead of submitting it', () => {
    const preferredQuickAgent = pickOrcaCloudAgent('aider')
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'aider',
        preferredQuickAgent,
        detectedAgentIds: ORCA_CLOUD_AGENT_IDS,
        offeredAgentIds: ORCA_CLOUD_AGENT_IDS
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: 'claude' })
  })

  it('keeps a pick the image ships', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'cursor',
        preferredQuickAgent: 'claude',
        detectedAgentIds: ORCA_CLOUD_AGENT_IDS,
        offeredAgentIds: ORCA_CLOUD_AGENT_IDS
      })
    ).toEqual({ quickAgent: 'cursor', quickAgentOverride: 'cursor' })
  })
})
