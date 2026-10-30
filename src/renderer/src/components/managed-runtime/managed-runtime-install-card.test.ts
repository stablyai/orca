import { describe, expect, it } from 'vitest'
import type {
  ManagedRuntimeInstallState,
  ManagedRuntimeOperation
} from '../../../../shared/managed-runtime-install'
import { managedRuntimeInstallCard } from './managed-runtime-install-card'

const idle: ManagedRuntimeInstallState = {
  agent: 'fake',
  revision: 1,
  available: true,
  version: '1.3.0',
  downloadBytes: 111_500_000,
  installedVersion: null,
  installedCurrent: false,
  source: null,
  operation: null
}

const op = (patch: Partial<ManagedRuntimeOperation>): ManagedRuntimeOperation => ({
  id: 'op-1',
  kind: 'install',
  phase: 'downloading',
  downloadedBytes: 41_200_000,
  totalBytes: 111_500_000,
  ...patch
})

describe('managedRuntimeInstallCard', () => {
  it('walks the hero and the strip through offer, run, failure and cancel', () => {
    const offer = managedRuntimeInstallCard(idle, 'Fake', 'hero')
    expect(offer).toMatchObject({
      title: 'Install Fake to start chatting',
      detail:
        "One-time 112 MB download. It's shared by Fake chats on the computer running this chat.",
      hint: 'Also in Settings › Agents',
      action: { kind: 'install', label: 'Install Fake' }
    })
    expect(managedRuntimeInstallCard(idle, 'Fake', 'strip')).toMatchObject({
      title: 'Install Fake to continue',
      detail: '112 MB download on the computer running this chat',
      action: { label: 'Install' }
    })

    const running = managedRuntimeInstallCard({ ...idle, operation: op({}) }, 'Fake', 'hero')
    expect(running).toMatchObject({
      title: 'Downloading Fake',
      progress: { detail: '41.2 of 111.5 MB', percentText: '37%' },
      action: { kind: 'cancel', label: 'Cancel', operationId: 'op-1' }
    })
    expect(running.steps?.map((step) => step.state)).toEqual(['current', 'todo', 'todo'])
    const checking = managedRuntimeInstallCard(
      { ...idle, operation: op({ phase: 'verifying' }) },
      'Fake',
      'strip',
      true
    )
    expect(checking.title).toBe('Cancelling…')
    expect(checking.progress).toMatchObject({ percent: null })
    expect(checking.steps?.map((step) => step.state)).toEqual(['done', 'done', 'current'])

    const failed = managedRuntimeInstallCard(
      {
        ...idle,
        operation: op({
          phase: 'failed',
          error: "Couldn't download Fake. Check your network connection or proxy, then try again."
        })
      },
      'Fake',
      'hero'
    )
    expect(failed).toMatchObject({
      tone: 'failed',
      title: "Couldn't install Fake",
      detail: "Couldn't download Fake. Check your network connection or proxy, then try again.",
      hint: '112 MB download.',
      action: { label: 'Try again' }
    })
    expect(
      managedRuntimeInstallCard({ ...idle, operation: op({ phase: 'cancelled' }) }, 'Fake', 'hero')
    ).toMatchObject({
      title: 'Installation cancelled',
      detail: 'Nothing was installed.',
      action: { label: 'Retry installation' }
    })
  })
})
