// The "Connect your GitHub so PRs show as you" line under the wizard's GitHub
// access step, in each state, inside the step list the way the build sheet draws it.
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { GitHubIdentityState } from '@/components/settings/accounts/orca/github-identity-model'
import type { CloudCreateGitHubAccess } from '@/lib/orca-cloud/cloud-create-github-access'
import { VmBuildGitHubAccessRowView } from './VmBuildGitHubAccessRow'
import { VmBuildGitHubIdentityLineView } from './VmBuildGitHubIdentityLine'

const ACCESS: CloudCreateGitHubAccess = {
  repoUrl: 'https://github.com/acme/web',
  repoName: 'acme/web',
  owner: 'acme',
  phase: 'ok',
  opened: false,
  remembered: false,
  holding: false
}

const noop = (): void => {}

function fixture(
  state: GitHubIdentityState,
  access: Partial<CloudCreateGitHubAccess> = {},
  connectedHere = false
) {
  return defineFixture({
    width: 760,
    render: () => (
      <div className="bg-background p-3">
        <ol className="flex flex-col rounded-lg border border-border bg-card px-4 py-2 text-sm">
          <VmBuildGitHubAccessRowView
            access={{ ...ACCESS, ...access }}
            actions={{
              open: noop,
              skip: noop,
              openNow: noop,
              reopen: noop,
              copyRequest: noop,
              copied: false
            }}
            identityLine={
              <VmBuildGitHubIdentityLineView
                state={state}
                connectedHere={connectedHere}
                onConnect={noop}
                onCancel={noop}
                onNotNow={noop}
              />
            }
          />
        </ol>
      </div>
    )
  })
}

export const ask = fixture({ kind: 'disconnected' })
export const askAfterSkip = fixture({ kind: 'disconnected' }, { phase: 'skipped', ask: 'install' })
export const waiting = fixture({ kind: 'pending' })
export const connectedHere = fixture(
  { kind: 'connected', login: 'octo-dev', githubUserId: 1 },
  {},
  true
)
export const alreadyConnected = fixture({ kind: 'connected', login: 'octo-dev', githubUserId: 1 })
