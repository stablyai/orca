import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentApiKeysState } from '../../../../../shared/agent-api-keys/agent-api-key-catalog'
import { AgentApiKeysPane } from './AgentApiKeysPane'
import type { AgentApiKeyHostChoice } from './AgentApiKeyEditor'
import type { AgentApiKeysModel } from './use-agent-api-keys'

const HOSTS: AgentApiKeyHostChoice[] = [
  { id: 'local', label: 'Local Mac' },
  { id: 'ssh:devbox', label: 'devbox' },
  { id: 'runtime:gpu-box', label: 'gpu-box' },
  { id: 'runtime:build-box', label: 'build-box' }
]

function model(state: AgentApiKeysState): AgentApiKeysModel {
  return { state, save: async () => null, remove: async () => null }
}

const SAVED: AgentApiKeysState = {
  protection: { available: true },
  keys: [
    {
      id: 'a',
      agent: 'claude',
      envName: 'ANTHROPIC_API_KEY',
      hostScope: { kind: 'all' },
      hint: '9fQ2',
      updatedAt: 2
    },
    {
      id: 'b',
      agent: 'claude',
      envName: 'AWS_BEARER_TOKEN_BEDROCK',
      hostScope: { kind: 'hosts', hostIds: ['ssh:devbox', 'runtime:gpu-box'] },
      hint: 'x7Lm',
      updatedAt: 1
    },
    {
      id: 'c',
      agent: 'codex',
      envName: 'OPENAI_API_KEY',
      hostScope: { kind: 'hosts', hostIds: ['runtime:build-box'] },
      hint: 'Q0aa',
      updatedAt: 3
    }
  ]
}

export const empty = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane model={model({ keys: [], protection: { available: true } })} hosts={HOSTS} />
  )
})

export const saved = defineFixture({
  width: 720,
  render: () => <AgentApiKeysPane model={model(SAVED)} hosts={HOSTS} />
})

export const adding = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model(SAVED)}
      hosts={HOSTS}
      initiallyEditing={{ agent: 'gemini', keyId: null }}
    />
  )
})

export const editingScoped = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model(SAVED)}
      hosts={HOSTS}
      initiallyEditing={{ agent: 'claude', keyId: 'b' }}
    />
  )
})

export const keychainUnavailable = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model({
        keys: [],
        protection: {
          available: false,
          reason:
            'Secrets are obfuscated with a built-in key, not protected by the OS keyring. Install and unlock gnome-keyring or kwallet, then restart Orca, to seal them properly.'
        }
      })}
      hosts={HOSTS}
    />
  )
})
