import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { VmBuildSheet } from '../worktree-creation/VmBuildSheet'
import type { CloudAgentReadiness } from './cloud-agent-readiness'
import { CloudAgentSetupView, type CloudAgentSetupViewProps } from './CloudAgentSetupView'
import { VmBuildCloudAgentStepView, type VmBuildCloudAgentStepModel } from './VmBuildCloudAgentStep'

const NONE: CloudAgentReadiness = { claude: null, codex: null }
const noop = (): void => {}
const setup = {
  onSave: async () => null,
  onSignIn: noop,
  onLater: noop
}

const ENTRY: PendingWorktreeCreation = {
  creationId: 'fixture',
  phase: 'provisioning-vm',
  status: 'creating',
  startedAt: 0,
  indeterminate: false,
  loaderVisible: true,
  provisioningLog: 'Creating Orca Cloud sandbox…\nCloning acme/web…',
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only name and ephemeralVmRecipe from the request.
  request: {
    name: 'fix-login',
    ephemeralVmRecipe: { sourceRepoId: 'repo', recipeId: 'cloud', projectId: 'p' }
  } as PendingWorktreeCreation['request']
}

function sheet(
  model: VmBuildCloudAgentStepModel,
  overrides: Partial<typeof setup> & Partial<CloudAgentSetupViewProps> = {}
) {
  return defineFixture({
    width: 760,
    render: () => (
      <div className="bg-background p-3">
        <VmBuildSheet
          creationId="fixture"
          entry={ENTRY}
          elapsedLabel="0:24"
          error={null}
          onCancel={noop}
          onRetry={noop}
          onDismiss={noop}
          onEditRecipe={noop}
          agentSignInRow={null}
          cloudAgentStep={
            <VmBuildCloudAgentStepView model={model} setup={{ ...setup, ...overrides }} />
          }
        />
      </div>
    )
  })
}

export const buildChoose = sheet({ kind: 'setup', readiness: NONE, canShare: false })

export const buildApiKeyAdmin = sheet(
  { kind: 'setup', readiness: NONE, canShare: true },
  { initialOption: 'api-key' }
)

export const buildGateway = sheet(
  { kind: 'setup', readiness: NONE, canShare: false },
  { initialOption: 'gateway' }
)

export const buildCustom = sheet(
  { kind: 'setup', readiness: NONE, canShare: false },
  { initialOption: 'custom', initialFailure: { error: 'invalid_base_url', field: 'baseUrl' } }
)

export const buildSubscriptionRefused = sheet(
  { kind: 'setup', readiness: NONE, canShare: false },
  {
    initialOption: 'api-key',
    initialFailure: { error: 'subscription_token_refused', field: 'key' }
  }
)

export const buildSaved = sheet(
  { kind: 'setup', readiness: NONE, canShare: true },
  { initialSaved: { agents: ['claude'], scope: 'org' } }
)

export const buildReadyDesktopKey = sheet({
  kind: 'ready',
  readiness: { claude: 'desktop-key', codex: null }
})

export const buildReadyTeam = sheet({
  kind: 'ready',
  readiness: { claude: 'team', codex: 'team' }
})

function Dialogish({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <div className="max-w-xl rounded-xl border border-border bg-popover p-6 shadow-floating">
        <p className="mb-2 text-base font-semibold">Add an agent</p>
        {children}
      </div>
    </div>
  )
}

export const settingsDialog = defineFixture({
  width: 640,
  render: () => (
    <Dialogish>
      <CloudAgentSetupView
        readiness={{ claude: 'team', codex: null }}
        canShare
        surface="dialog"
        onSave={async () => null}
        onLater={noop}
      />
    </Dialogish>
  )
})

export const settingsDialogApiKey = defineFixture({
  width: 640,
  render: () => (
    <Dialogish>
      <CloudAgentSetupView
        readiness={NONE}
        canShare={false}
        surface="dialog"
        onSave={() => new Promise(() => {})}
        onLater={noop}
        initialOption="api-key"
      />
    </Dialogish>
  ),
  interact: async (frame) => {
    const input = frame.querySelector<HTMLInputElement>('input[type="password"]')
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'sk-ant-api03-Zq9xR2mVt8LwPcA1'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
    frame.querySelector<HTMLButtonElement>('button[aria-pressed]')?.click()
    frame.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})
