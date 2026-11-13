import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudSetupNotice } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'
import { translate } from '@/i18n/i18n'
import type { CloudPushAccess } from '@/lib/orca-cloud/cloud-push-access'
import { cloudSetupNoticesView } from './CloudSetupNotices'
import { CloudToastCard, type CloudToastView } from './cloud-toast-stack'

const noop = (): void => {}

const PUSH: CloudSetupNotice = {
  id: 'git.push',
  kind: 'push',
  check: { id: 'git.push', category: 'git', status: 'fail', message: 'push refused' }
}
const SETUP: CloudSetupNotice = {
  id: 'setup.run',
  kind: 'setup',
  check: {
    id: 'setup.run',
    category: 'setup',
    status: 'warn',
    message: 'Setup script is configured but has not run here.',
    code: 'setupNotRun'
  }
}

const FETCH: CloudSetupNotice = {
  id: 'git.fetch',
  kind: 'fetch',
  check: {
    id: 'git.fetch',
    category: 'git',
    status: 'fail',
    message: 'Cannot reach remote "origin".'
  }
}

const DISK_LOW: CloudSetupNotice = {
  id: 'disk.free',
  kind: 'disk',
  check: {
    id: 'disk.free',
    category: 'disk',
    status: 'fail',
    message: 'Only 0.8 GB free.',
    code: 'diskVeryLow',
    params: { free: '0.8' }
  }
}

const TOOL_MISSING: CloudSetupNotice = {
  id: 'tool.pnpm',
  kind: 'tool',
  check: {
    id: 'tool.pnpm',
    category: 'tools',
    status: 'fail',
    message: 'pnpm is not on PATH, but pnpm-lock.yaml needs it.',
    code: 'toolMissing',
    params: { command: 'pnpm', reason: 'pnpm-lock.yaml' }
  }
}

function notices(
  list: readonly CloudSetupNotice[],
  options: {
    installing?: boolean
    checkingFetch?: boolean
    access?: CloudPushAccess
    repoUrl?: string
  } = {}
) {
  return cloudSetupNoticesView(
    { repoUrl: options.repoUrl ?? 'https://github.com/stablyai/orca', environmentId: 'env' },
    list,
    translate,
    {
      push: {
        access: options.access ?? 'install',
        installing: options.installing ?? false,
        install: noop,
        copyRequest: noop,
        recheck: noop
      },
      runSetup: noop,
      dismiss: noop,
      recheckFetch: noop,
      checkingFetch: options.checkingFetch ?? false
    }
  )
}

// The agent prompt as composer-redo shows it: action-required, one primary button.
const AGENT: CloudToastView = {
  priority: 'action',
  lines: [
    {
      key: 'agent',
      text: 'Claude isn’t set up for Orca Cloud, so it didn’t start.',
      action: { label: 'Set up Claude once', primary: true, onClick: noop }
    }
  ]
}

function cards(views: readonly CloudToastView[]) {
  return defineFixture({
    width: 420,
    render: () => (
      <div className="flex flex-col items-end gap-3 bg-background p-4">
        {views.map((view) => (
          <CloudToastCard key={view.lines[0]?.key} view={view} onDismiss={noop} />
        ))}
      </div>
    )
  })
}

/** The push-access case Neil hit: public repo, App installed only on his personal account. */
export const pushOnly = cards([notices([PUSH])])
export const pushWaitingForGitHub = cards([notices([PUSH], { installing: true })])
/** ENV-NOTICE-ACTIONS: someone else's public repository: no Install, a request to copy for an owner. */
export const pushNotInstallable = cards([
  notices([PUSH], {
    access: 'cantInstall',
    repoUrl: 'https://github.com/octocat/Hello-World'
  })
])
/** An owner was already asked to approve the App: copy a request to nudge them. */
export const pushRequested = cards([notices([PUSH], { access: 'requested' })])
/** Plain words, no button: a sandbox's disk can't be grown from Orca. */
export const diskLow = cards([notices([DISK_LOW])])
/** Plain words naming the tool and what needs it; Orca can't install it, so no button. */
export const toolMissing = cards([notices([TOOL_MISSING])])
export const setupOnly = cards([notices([SETUP])])
/** One family (DS-q): the action-required prompt and the warning, same chrome. */
export const agentAndPush = cards([AGENT, notices([PUSH, SETUP])])
/** ENV-ORIGIN-TOAST: origin still unreachable after two confirming checks; Check again re-runs it. */
export const fetchFailed = cards([notices([FETCH])])
export const fetchChecking = cards([notices([FETCH], { checkingFetch: true })])
