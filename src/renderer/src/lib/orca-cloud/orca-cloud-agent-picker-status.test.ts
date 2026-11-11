import { describe, expect, it } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { Translate } from '@/i18n/use-translate'
import type { OrcaCloudAgentAccountsRead } from './orca-cloud-agent-accounts-model'
import {
  orcaCloudAgentPickerStatus,
  orcaCloudAgentPickerStatusLabel
} from './orca-cloud-agent-picker-status'

function status(patch: Partial<OrcaCloudAgentsStatus['credentials']> = {}): OrcaCloudAgentsStatus {
  return {
    credentials: {
      claude: { state: 'none' },
      codex: { state: 'none' },
      providerEnabled: { claude: true, codex: true },
      ...patch
    },
    sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
  }
}

function accounts(
  load: OrcaCloudAgentAccountsRead['load'],
  names: string[] | null = []
): OrcaCloudAgentAccountsRead & { cloudSecretNames: ReadonlySet<string> | null } {
  return {
    load,
    keyKinds: { claude: null, codex: null },
    cloudSecretNames: names ? new Set(names) : null
  }
}

describe('orcaCloudAgentPickerStatus (JA-22)', () => {
  it('shows nothing until the account is read', () => {
    expect(orcaCloudAgentPickerStatus('claude', accounts({ kind: 'loading' }))).toBeNull()
    expect(orcaCloudAgentPickerStatus('gemini', accounts({ kind: 'loading' }, null))).toBeNull()
  })

  it('reads Claude and Codex from the Orca account', () => {
    const ready = accounts({ kind: 'ready', status: status({ claude: { state: 'active' } }) })
    expect(orcaCloudAgentPickerStatus('claude', ready)).toBe('ready')
    expect(orcaCloudAgentPickerStatus('codex', ready)).toBe('setUp')
    const expired = accounts({ kind: 'ready', status: status({ claude: { state: 'expired' } }) })
    expect(orcaCloudAgentPickerStatus('claude', expired)).toBe('setUp')
  })

  it('says a paused or never-offered provider signs in per workspace, never "Set up"', () => {
    const off = accounts({
      kind: 'ready',
      status: status({
        providerEnabled: { claude: false, codex: false },
        providerState: { claude: 'off', codex: 'disabled' }
      })
    })
    expect(orcaCloudAgentPickerStatus('claude', off)).toBe('perWorkspace')
    expect(orcaCloudAgentPickerStatus('codex', off)).toBe('perWorkspace')
  })

  it('reads API-key agents from Cloud secret names only', () => {
    const load = { kind: 'ready', status: status() } as const
    expect(orcaCloudAgentPickerStatus('gemini', accounts(load, ['GOOGLE_API_KEY']))).toBe('ready')
    expect(orcaCloudAgentPickerStatus('cursor', accounts(load, ['GOOGLE_API_KEY']))).toBe('setUp')
    expect(orcaCloudAgentPickerStatus('copilot', accounts(load, ['COPILOT_GITHUB_TOKEN']))).toBe(
      'ready'
    )
    expect(orcaCloudAgentPickerStatus('opencode', accounts(load, ['OPENAI_API_KEY']))).toBe('ready')
    expect(orcaCloudAgentPickerStatus('opencode', accounts(load, []))).toBe('setUp')
  })

  it('marks agents the image does not ship', () => {
    expect(orcaCloudAgentPickerStatus('aider', accounts({ kind: 'loading' }))).toBe('notAvailable')
  })
})

describe('orcaCloudAgentPickerStatusLabel (JA-22)', () => {
  const t: Translate = (_key, fallback) => fallback
  it('says nothing for ready and names the state otherwise', () => {
    expect(orcaCloudAgentPickerStatusLabel('ready', t)).toBeNull()
    expect(orcaCloudAgentPickerStatusLabel('setUp', t)).toBe('Not set up')
    expect(orcaCloudAgentPickerStatusLabel('perWorkspace', t)).toBe('Signs in per workspace')
  })
})
