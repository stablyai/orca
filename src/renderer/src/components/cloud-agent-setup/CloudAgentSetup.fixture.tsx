import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { VmBuildSheet } from '../worktree-creation/VmBuildSheet'
import type { CloudAgentReadiness } from './cloud-agent-readiness'
import type { CloudAgentSetupFailure, CloudAgentSetupOption } from './cloud-agent-setup-choices'
import { CloudAgentSetupSavedNotice, CloudAgentSetupView } from './CloudAgentSetupView'
import {
  VmBuildCloudAgentStepView,
  type VmBuildCloudAgentStepMode,
  type VmBuildCloudAgentStepModel
} from './VmBuildCloudAgentStep'

const NONE: CloudAgentReadiness = { claude: null, codex: null }
const noop = (): void => {}
const actions = {
  onSave: async () => null,
  onDone: noop,
  onSignIn: noop,
  onCancelSignIn: noop,
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
  initialMode?: VmBuildCloudAgentStepMode,
  interact?: (frame: HTMLElement) => Promise<void>
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
          cloudAgentStep={
            <VmBuildCloudAgentStepView model={model} actions={actions} initialMode={initialMode} />
          }
        />
      </div>
    ),
    interact
  })
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) {
    return
  }
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export const buildOffer = sheet({ readiness: NONE, canShare: false })

export const buildKeysAdmin = sheet({ readiness: NONE, canShare: true }, { kind: 'keys' })

export const buildSignInPending = sheet({ readiness: NONE, canShare: false }, { kind: 'signIn' })

export const buildSkipped = sheet({ readiness: NONE, canShare: false }, { kind: 'skipped' })

export const buildSaved = sheet(
  { readiness: NONE, canShare: true },
  { kind: 'saved', saved: { agents: ['claude'], scope: 'org' } }
)

export const buildReadyDesktopKey = sheet({
  readiness: { claude: 'desktop-key', codex: null },
  canShare: false
})

export const buildReadyTeam = sheet({
  readiness: { claude: 'team', codex: 'team' },
  canShare: false
})

function Dialogish({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <div className="max-w-xl space-y-4 rounded-xl border border-border bg-popover p-6 shadow-floating">
        <div className="space-y-1.5">
          <p className="text-base font-semibold">Add an agent</p>
          <p className="text-sm text-muted-foreground">
            Choose how Claude Code or Codex gets access in your Orca Cloud workspaces.
          </p>
        </div>
        {children}
      </div>
    </div>
  )
}

function dialog(
  option: CloudAgentSetupOption,
  options: {
    readiness?: CloudAgentReadiness
    canShare?: boolean
    failure?: CloudAgentSetupFailure
    pendingSave?: boolean
    interact?: (frame: HTMLElement) => Promise<void>
  } = {}
) {
  return defineFixture({
    width: 640,
    render: () => (
      <Dialogish>
        <CloudAgentSetupView
          readiness={options.readiness ?? NONE}
          canShare={options.canShare ?? false}
          steadyHeight
          onSave={options.pendingSave ? () => new Promise(() => {}) : async () => null}
          onSaved={noop}
          onCancel={noop}
          initialOption={option}
          initialFailure={options.failure ?? null}
        />
      </Dialogish>
    ),
    interact: options.interact
  })
}

export const dialogSubscription = dialog('sign-in', { readiness: { claude: 'team', codex: null } })

export const dialogApiKeyAdmin = dialog('api-key', { canShare: true })

export const dialogApiKeySaving = dialog('api-key', {
  pendingSave: true,
  interact: async (frame) => {
    typeInto(frame.querySelector('input[type="password"]'), 'sk-ant-api03-Zq9xR2mVt8LwPcA1')
    await settle()
    frame.querySelector<HTMLButtonElement>('button[aria-pressed]')?.click()
    frame.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await settle()
  }
})

export const dialogSubscriptionRefused = dialog('api-key', {
  failure: { error: 'subscription_token_refused', field: 'key' }
})

export const dialogGateway = dialog('gateway')

export const dialogCustomInvalid = dialog('custom', {
  failure: { error: 'invalid_base_url', field: 'baseUrl' }
})

export const dialogServerError = dialog('gateway', { failure: { error: 'unavailable' } })

export const dialogSaved = defineFixture({
  width: 640,
  render: () => (
    <Dialogish>
      <CloudAgentSetupSavedNotice
        saved={{ agents: ['claude', 'codex'], scope: 'personal' }}
        onClose={noop}
      />
    </Dialogish>
  )
})
