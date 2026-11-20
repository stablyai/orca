import { defineFixture } from '../../../component-fixtures/component-fixture'
import { IntegrationCardPresentationProvider } from '../presentation/integration-card-presentation'
import { AzureDevOpsIntegrationCard } from './azure-devops-integration-card'
import type { AzureDevOpsHostAuth } from './use-azure-devops-host-auth'

const noCredential = {
  configured: false,
  authenticated: false,
  account: null,
  baseUrl: null,
  tokenConfigured: false,
  credentialAvailable: false
}

function azureDevOpsFixture(state: AzureDevOpsHostAuth, open = false) {
  return defineFixture({
    width: 600,
    render: () => (
      <IntegrationCardPresentationProvider value="setup-guide">
        <AzureDevOpsIntegrationCard
          state={state}
          hostLabel="This computer"
          onRefresh={() => {}}
          onSave={() => {}}
        />
      </IntegrationCardPresentationProvider>
    ),
    interact: open
      ? (frame) => {
          const trigger = frame.querySelector<HTMLButtonElement>('[role="combobox"]')
          if (!trigger) {
            throw new Error('Azure DevOps authentication selector not found')
          }
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        }
      : undefined
  })
}

const environmentState = {
  phase: 'ready',
  method: 'environment',
  checking: false,
  status: { ...noCredential, credentialState: 'not-configured' }
} satisfies AzureDevOpsHostAuth

export const environment = azureDevOpsFixture(environmentState)
export const openSelector = azureDevOpsFixture(environmentState, true)
export const cliReady = azureDevOpsFixture({
  phase: 'ready',
  method: 'azure-cli',
  checking: false,
  status: {
    ...noCredential,
    configured: true,
    credentialState: 'credential-ready',
    credentialAvailable: true
  }
})
export const cliError = azureDevOpsFixture({
  phase: 'ready',
  method: 'azure-cli',
  checking: false,
  status: {
    ...noCredential,
    configured: true,
    credentialState: 'error',
    errorCode: 'login-required'
  }
})
