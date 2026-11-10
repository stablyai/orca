import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudAgentReadiness } from './cloud-agent-readiness'
import type { CloudAgentSetupFailure, CloudAgentSetupOption } from './cloud-agent-setup-choices'
import { CloudAgentSetupSavedNotice, CloudAgentSetupView } from './CloudAgentSetupView'

const NONE: CloudAgentReadiness = { claude: null, codex: null }
const noop = (): void => {}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) {
    return
  }
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const DESKTOP_KEYS = [
  { id: 'k1', agent: 'claude', envName: 'ANTHROPIC_API_KEY', hint: 'x4Qa' },
  { id: 'k2', agent: 'gemini', envName: 'GEMINI_API_KEY', hint: '9fZk' }
] as const

function Dialogish({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <div className="max-w-xl space-y-4 rounded-xl border border-border bg-popover p-6 shadow-floating">
        <div className="space-y-1.5">
          <p className="text-base font-semibold">Add an agent</p>
          <p className="text-sm text-muted-foreground">
            Choose how your agents get access in your Orca Cloud workspaces.
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
    desktopKeys?: boolean
    desktopKeyFailure?: boolean
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
          desktopKeys={options.desktopKeys ? [...DESKTOP_KEYS] : []}
          onSaveDesktopKey={async (key) =>
            options.desktopKeyFailure && key.envName === 'GEMINI_API_KEY' ? 'unavailable' : null
          }
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

export const dialogDesktopKeys = dialog('api-key', { desktopKeys: true })

/** One key saved, the next one failed: each row keeps its own outcome. */
export const dialogDesktopKeysSavedAndFailed = dialog('api-key', {
  desktopKeys: true,
  desktopKeyFailure: true,
  interact: async (frame) => {
    for (const button of frame.querySelectorAll<HTMLButtonElement>('[aria-label^="Save "]')) {
      button.click()
      await settle()
    }
  }
})

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

export const dialogDiscardConfirm = dialog('api-key', {
  interact: async (frame) => {
    const key = frame.querySelector<HTMLInputElement>('input[type="password"]')
    typeInto(key, 'sk-ant-api03-Zq9xR2mVt8LwPcA1')
    await settle()
    key?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
  }
})

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
