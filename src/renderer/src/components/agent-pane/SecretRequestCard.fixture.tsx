import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  SecretRequestCard,
  type SecretRequestCardActions,
  type SecretRequestCardModel
} from './SecretRequestCard'

const noop = (): void => {}
const ACTIONS: SecretRequestCardActions = {
  onValueChange: noop,
  onScopeChange: noop,
  onAdd: noop,
  onNotNow: noop,
  onRetry: noop,
  onRestart: noop,
  onDismiss: noop,
  onToggleCollapsed: noop,
  onCollapse: noop,
  onDetails: noop
}

const BASE: SecretRequestCardModel = {
  agent: 'Claude',
  name: 'NPM_TOKEN',
  reason: 'Needed to install @acme packages from npm.acme.dev.',
  suggestedRepo: false,
  scopes: ['personal', 'repo'],
  scope: 'personal',
  value: '',
  phase: 'open',
  fieldError: null,
  more: 0,
  canRestart: true,
  collapsed: false,
  sharedWorkspace: false
}

/** A terminal pane behind the card, as it sits over a Claude session. */
function Pane({ model }: { model: Partial<SecretRequestCardModel> }): React.JSX.Element {
  return (
    <div className="bg-background p-3">
      <div className="relative h-[340px] overflow-hidden rounded-lg border border-border bg-[var(--terminal-background,#111)] p-3 font-mono text-xs leading-5 text-muted-foreground">
        <p>● Installing private packages…</p>
        <p>npm ERR! 401 Unauthorized - GET https://npm.acme.dev/@acme%2fui</p>
        <p>● I need an npm token for npm.acme.dev to continue.</p>
        <div className="absolute inset-x-3 top-3 flex justify-end">
          <SecretRequestCard model={{ ...BASE, ...model }} actions={ACTIONS} className="max-w-md" />
        </div>
      </div>
    </div>
  )
}

const frame = (model: Partial<SecretRequestCardModel>) =>
  defineFixture({ width: 640, render: () => <Pane model={model} /> })

export const open = frame({ value: 'npm_9f2cA81bX7' })
export const openWithMore = frame({ more: 2 })
export const repoHint = frame({ suggestedRepo: true })
export const personalOnly = frame({ scopes: ['personal'] })
/** SEC-5: a shared workspace, and the person can write the repository: Repository only. */
export const sharedRepoOnly = frame({ sharedWorkspace: true, scopes: ['repo'], scope: 'repo' })
/** SEC-5: a shared workspace, and nothing this person can write reaches it. */
export const sharedNoScope = frame({ sharedWorkspace: true, scopes: [], scope: 'personal' })
export const unknownAgent = frame({ agent: null, canRestart: false })
export const longReason = frame({
  reason:
    'The install step pulls @acme/ui, @acme/icons and @acme/tokens from the private registry at npm.acme.dev, which answers 401 without a token. I tried the public mirror first, but these packages are not published there, so I need NPM_TOKEN to finish setting up.'
})
export const saving = frame({ value: 'npm_9f2cA81bX7', phase: 'saving' })
export const refused = frame({
  value: 'x'.repeat(12),
  fieldError: 'Values can be up to 8 KB.'
})
export const failed = frame({ value: 'npm_9f2cA81bX7', phase: 'failed' })
export const saved = frame({ phase: 'saved' })
export const savedRepo = frame({ phase: 'saved', scope: 'repo' })
export const savedAfterExpiry = frame({ phase: 'savedAfterExpiry' })
export const expired = frame({ phase: 'expired' })
export const collapsed = frame({ collapsed: true, more: 1 })
export const notOnAskingPane = frame({ phase: 'saved', canRestart: false })
