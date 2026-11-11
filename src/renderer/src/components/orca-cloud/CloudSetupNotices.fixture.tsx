import { defineFixture } from '../../component-fixtures/component-fixture'
import type { CloudSetupNotice } from '@/lib/ephemeral-vm-environment-check-triage'
import { CloudSetupNoticesView } from './CloudSetupNotices'

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
const DISK: CloudSetupNotice = {
  id: 'disk.free',
  kind: 'check',
  check: {
    id: 'disk.free',
    category: 'disk',
    status: 'warn',
    message: 'Only 3.2 GB free.',
    code: 'diskLow',
    params: { free: '3.2' }
  }
}

function notices(list: readonly CloudSetupNotice[], installing = false) {
  return defineFixture({
    width: 480,
    render: () => (
      <div className="flex justify-end bg-background p-4">
        <CloudSetupNoticesView
          record={{ repoUrl: 'https://github.com/stablyai/orca' }}
          notices={list}
          installing={installing}
          onInstall={noop}
          onRunSetup={noop}
          onDismiss={noop}
        />
      </div>
    )
  })
}

/** The push-access case Neil hit: public repo, App installed only on his personal account. */
export const pushOnly = notices([PUSH])
export const pushWaitingForGitHub = notices([PUSH], true)
export const setupOnly = notices([SETUP])
export const allThree = notices([PUSH, SETUP, DISK])
