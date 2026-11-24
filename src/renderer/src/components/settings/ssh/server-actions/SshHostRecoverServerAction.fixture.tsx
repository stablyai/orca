import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { OrcadManagedStaleLockReclaimResult } from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import type { SshManagedServerStatus } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import { SshHostRecoverServerDialog } from './SshHostRecoverServerAction'

const DETAIL =
  'orcad holds the data root. If it is not running anywhere, run `/opt/bun /slot/orcad.js --reclaim-stale-lock --data-root /home/dev/.orca` on the machine it ran on.'

const status: SshManagedServerStatus = {
  kind: 'managed',
  environmentId: 'env-devbox-2',
  serving: { state: 'unverifiable', detail: DETAIL }
}

const eligible: OrcadManagedStaleLockReclaimResult = {
  status: 'eligible',
  message: 'The lock was written before this host last restarted.',
  lockPath: '/home/dev/.orca/orcad.lock',
  evidence: {
    pid: 4182,
    host: 'devbox-2',
    bootId: '6f1c2e0a-9b7d-4c3e-8a51-2d0f6b9e7c14',
    currentBootId: 'b83e5d27-1f4a-4a0c-9e62-7c5d3b1a0f98',
    ageMinutes: 190,
    nonce: 'nonce-1'
  }
}

function clickButton(label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  button?.click()
}

async function confirmAndClear(): Promise<void> {
  // Why wait: the eligibility check resolves after first paint.
  await new Promise((resolve) => setTimeout(resolve, 50))
  document.querySelector<HTMLButtonElement>('button[role="checkbox"]')?.click()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  clickButton('Clear lock and restart')
}

function dialogFixture(
  reclaim: (args: { yes: boolean }) => Promise<OrcadManagedStaleLockReclaimResult>,
  interact?: () => Promise<void>
) {
  return defineFixture({
    width: 640,
    setup: () => {
      Object.assign(window.api.runtimeEnvironments, {
        managedOrcad: { reclaimStaleLock: reclaim }
      })
    },
    render: () => (
      <div className="h-[360px] bg-background">
        <SshHostRecoverServerDialog
          status={status}
          open
          onOpenChange={() => {}}
          onChanged={() => {}}
        />
      </div>
    ),
    interact
  })
}

export const checking = dialogFixture(() => new Promise(() => {}))

export const readyToClear = dialogFixture(() => Promise.resolve(eligible))

export const clearing = dialogFixture(
  ({ yes }) => (yes ? new Promise(() => {}) : Promise.resolve(eligible)),
  confirmAndClear
)

export const clearFailed = dialogFixture(
  ({ yes }) =>
    yes
      ? Promise.reject(new Error('devbox-2 closed the connection before the lock was cleared.'))
      : Promise.resolve(eligible),
  confirmAndClear
)
