import { useTranslation } from 'react-i18next'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { WorkerRoleProfileEditor } from './WorkerRoleProfileEditor'

function WorkerRoleFixture(): React.JSX.Element {
  useTranslation()
  return (
    <div className="rounded-md border border-border bg-card p-4 text-card-foreground">
      <WorkerRoleProfileEditor
        role="implementation"
        profile={{ agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' }}
        detectedIds={['codex']}
        disabledAgents={[]}
        disabled={false}
        structuredFast
        onChange={() => {}}
      />
    </div>
  )
}

const catalog: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  modelsDifferByWorkspace: true,
  fastModeSupport: { supported: true },
  models: [
    {
      id: 'gpt-6.1-sol',
      label: 'GPT 6.1 Sol',
      isDefault: false,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ],
      supportsFastMode: true
    },
    {
      id: 'gpt-6-astra',
      label: 'GPT 6 Astra',
      isDefault: false,
      efforts: [{ value: 'high', label: 'High' }],
      supportsFastMode: false
    }
  ]
}
const setup = (): void => {
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY])
  window.api.runtime.call = async ({ method }) => {
    if (method !== 'agentSession.modelCatalog') {
      throw new Error(`Unexpected fixture request: ${method}`)
    }
    return { id: 'fixture', ok: true, result: catalog, _meta: { runtimeId: 'fixture' } }
  }
}
const fixture = (field: 'agent' | 'model') =>
  defineFixture({
    width: 480,
    setup,
    render: () => <WorkerRoleFixture />,
    interact: async () => {
      await i18n.changeLanguage(await loadRendererUiLanguage('en'))
      document
        .getElementById(`worker-role-implementation-${field}`)
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    }
  })
export const agents = fixture('agent')
export const models = fixture('model')

export const retrievalFailure = defineFixture({
  width: 480,
  setup: () => {
    setup()
    window.api.runtime.call = async () => {
      throw new Error(
        'Host connection closed: socket timeout and transport diagnostics. '.repeat(40)
      )
    }
  },
  render: () => <WorkerRoleFixture />,
  interact: async () => {
    await i18n.changeLanguage(await loadRendererUiLanguage('en'))
  }
})
