import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentApiKeysState } from '../../../../../shared/agent-api-keys/agent-api-key-catalog'
import type { AgentApiKeysScanResult } from '../../../../../shared/agent-api-keys/agent-api-key-cloud'
import { AgentApiKeysPane } from './AgentApiKeysPane'
import type { AgentApiKeyHostChoice } from './AgentApiKeyEditor'
import type { AgentApiKeysModel } from './use-agent-api-keys'

const HOSTS: AgentApiKeyHostChoice[] = [
  { id: 'local', label: 'Local Mac' },
  { id: 'ssh:devbox', label: 'devbox' },
  { id: 'runtime:gpu-box', label: 'gpu-box' },
  { id: 'runtime:build-box', label: 'build-box' }
]

function model(
  state: AgentApiKeysState,
  extra: Partial<AgentApiKeysModel> = {}
): AgentApiKeysModel {
  return {
    state,
    save: async () => null,
    remove: async () => null,
    saveToAccount: async () => null,
    scanThisComputer: async () => ({ keys: [], signIns: [] }),
    importFromThisComputer: async () => null,
    ...extra
  }
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

// D12: keys saved while signed in to Orca also live in the Orca account.
const CLOUD_KEYS: AgentApiKeysState['keys'] = [
  {
    id: 'synced',
    agent: 'claude',
    envName: 'ANTHROPIC_API_KEY',
    hostScope: { kind: 'all' },
    hint: '9fQ2',
    updatedAt: 2
  },
  {
    id: 'bedrock',
    agent: 'claude',
    envName: 'AWS_BEARER_TOKEN_BEDROCK',
    hostScope: { kind: 'all' },
    hint: 'x7Lm',
    updatedAt: 1
  },
  {
    id: 'local',
    agent: 'codex',
    envName: 'OPENAI_API_KEY',
    hostScope: { kind: 'all' },
    hint: 'Q0aa',
    updatedAt: 3
  },
  {
    id: 'scoped',
    agent: 'gemini',
    envName: 'GEMINI_API_KEY',
    hostScope: { kind: 'hosts', hostIds: ['ssh:devbox'] },
    hint: 'Zk19',
    updatedAt: 4
  }
]

const SIGNED_IN: AgentApiKeysState = {
  protection: { available: true },
  keys: CLOUD_KEYS,
  cloud: { signedIn: true, synced: ['synced'], managed: ['synced'] }
}

/** One key synced, one the proxy can't swap, one only here, one scoped to a host. */
export const cloudSynced = defineFixture({
  width: 720,
  render: () => <AgentApiKeysPane model={model(SIGNED_IN)} hosts={HOSTS} />
})

/** The account write failed after a local save: the key reads as only on this computer. */
export const cloudLocalOnly = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model(SIGNED_IN, { cloudFailures: { local: 'unavailable' } })}
      hosts={HOSTS}
    />
  )
})

/** Signed out: every key reads as it always has. */
export const cloudSignedOut = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model({ ...SIGNED_IN, cloud: { signedIn: false, synced: [], managed: [] } })}
      hosts={HOSTS}
    />
  )
})

const SCAN: AgentApiKeysScanResult = {
  keys: [
    {
      name: 'OPENAI_API_KEY',
      agent: 'codex',
      source: 'shell-env',
      hint: 'a1B2',
      alreadySaved: false
    },
    {
      name: 'AI_GATEWAY_API_KEY',
      agent: 'opencode',
      source: 'opencode-auth',
      hint: 'gw90',
      alreadySaved: false
    },
    {
      name: 'GEMINI_API_KEY',
      agent: 'gemini',
      source: 'gemini-env-file',
      hint: 'Zk19',
      alreadySaved: true
    }
  ],
  signIns: [{ agent: 'opencode', provider: 'anthropic' }]
}

export const importList = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model(SIGNED_IN)}
      hosts={HOSTS}
      initialImport={{ kind: 'ready', scan: SCAN }}
    />
  )
})

export const importEmpty = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model({ keys: [], protection: { available: true } })}
      hosts={HOSTS}
      initialImport={{ kind: 'ready', scan: { keys: [], signIns: [] } }}
    />
  )
})

export const importScanning = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane model={model(SIGNED_IN)} hosts={HOSTS} initialImport={{ kind: 'scanning' }} />
  )
})

const STALE: AgentApiKeysState = {
  ...SIGNED_IN,
  cloud: { signedIn: true, synced: [], managed: ['synced'] }
}

/** The account holds an older copy of a key this computer saved there. */
export const cloudStale = defineFixture({
  width: 720,
  render: () => <AgentApiKeysPane model={model(STALE)} hosts={HOSTS} />
})

/** An edit saved here, but the account write failed: one line, with retry. */
export const cloudStaleFailed = defineFixture({
  width: 720,
  render: () => (
    <AgentApiKeysPane
      model={model(STALE, { cloudFailures: { synced: 'timeout' } })}
      hosts={HOSTS}
    />
  )
})
