import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudSetupNotice } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'
import { translate } from '@/i18n/i18n'
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

function notices(list: readonly CloudSetupNotice[], installing = false, checkingFetch = false) {
  return cloudSetupNoticesView(
    { repoUrl: 'https://github.com/stablyai/orca', environmentId: 'env' },
    list,
    translate,
    { installing, install: noop, runSetup: noop, dismiss: noop, recheckFetch: noop, checkingFetch }
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
export const pushWaitingForGitHub = cards([notices([PUSH], true)])
export const setupOnly = cards([notices([SETUP])])
/** One family (DS-q): the action-required prompt and the warning, same chrome. */
export const agentAndPush = cards([AGENT, notices([PUSH, SETUP])])
/** ENV-ORIGIN-TOAST: origin still unreachable after two confirming checks; Check again re-runs it. */
export const fetchFailed = cards([notices([FETCH])])
export const fetchChecking = cards([notices([FETCH], false, true)])
