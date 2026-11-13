// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { stack } = vi.hoisted(() => ({ stack: { show: vi.fn(), hide: vi.fn() } }))
vi.mock('./cloud-toast-stack', () => ({ showCloudToast: stack.show, hideCloudToast: stack.hide }))
const { recheck } = vi.hoisted(() => ({ recheck: vi.fn(async () => 'unreachable' as const) }))
vi.mock('@/lib/orca-cloud/cloud-fetch-notice', () => ({ recheckCloudFetch: recheck }))
const { pushAccess, copyRequest } = vi.hoisted(() => ({
  pushAccess: vi.fn(async (): Promise<string> => 'install'),
  copyRequest: vi.fn(async () => true)
}))
vi.mock('@/lib/orca-cloud/cloud-push-access', () => ({
  fetchCloudPushAccess: pushAccess
}))
// The shared request (owner-request.ts) reads the install link from repo access, then copies.
vi.mock('@/lib/orca-cloud/use-orca-cloud-repo-access', () => ({
  fetchOrcaCloudRepoAccess: async () => null
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ ephemeralVmRuntimesByWorkspaceId: { w1: { runtimeEnvironmentId: 'env-1' } } })
}))

import { CloudSetupNoticesDock, cloudSetupNoticeLine, cloudSetupToastId } from './CloudSetupNotices'
import type { CloudSetupNotice } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'
import type { CloudPushAccess } from '@/lib/orca-cloud/cloud-push-access'
import { translate } from '@/i18n/i18n'
import {
  dismissCloudSetupNotice,
  resetCloudSetupNotices,
  setCloudSetupNotices
} from '@/lib/orca-cloud/cloud-setup-notices-store'

afterEach(() => {
  cleanup()
  resetCloudSetupNotices()
  vi.clearAllMocks()
})

describe('CloudSetupNoticesDock (DS-o, DS-q)', () => {
  it('is one warning in the shared cloud toast stack, and leaves with its workspace', async () => {
    setCloudSetupNotices({
      environmentId: 'env-1',
      path: '/w',
      repoId: 'r',
      hostId: null,
      repoUrl: 'https://github.com/stablyai/orca',
      notices: [
        {
          id: 'git.push',
          kind: 'push',
          check: { id: 'git.push', category: 'git', status: 'fail', message: 'refused' }
        }
      ]
    })
    const view = render(<CloudSetupNoticesDock workspaceId="w1" />)
    // The access answer arrives after the first render.
    await act(async () => {})
    const [id, shown] = stack.show.mock.calls.at(-1) ?? []
    expect(id).toBe(cloudSetupToastId('env-1'))
    expect(shown.priority).toBe('warning')
    // "Install on stablyai" stays outline: a way forward, not the required next step.
    expect(shown.lines[0].action).toMatchObject({ label: 'Install on stablyai' })
    expect(shown.lines[0].action.primary).toBeUndefined()
    // Its last line dismissed: the toast goes too.
    dismissCloudSetupNotice('env-1', 'git.push')
    view.rerender(<CloudSetupNoticesDock workspaceId="w1" />)
    expect(stack.hide).toHaveBeenCalledWith(cloudSetupToastId('env-1'))
    stack.hide.mockClear()
    vi.useFakeTimers()
    view.unmount()
    // Applied a tick later, so a StrictMode remount can claim the toast back first.
    expect(stack.hide).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(stack.hide).toHaveBeenCalledWith(cloudSetupToastId('env-1'))
    vi.useRealTimers()
  })

  it("can't reach GitHub: says which repository and offers Check again, never a bare line (ENV-ORIGIN-TOAST)", () => {
    setCloudSetupNotices({
      environmentId: 'env-1',
      path: '/w',
      repoId: 'r',
      hostId: null,
      repoUrl: 'https://github.com/stablyai/orca',
      notices: [
        {
          id: 'git.fetch',
          kind: 'fetch',
          check: {
            id: 'git.fetch',
            category: 'git',
            status: 'fail',
            message: 'Cannot reach remote "origin".'
          }
        }
      ]
    })
    render(<CloudSetupNoticesDock workspaceId="w1" />)
    const [, shown] = stack.show.mock.calls.at(-1) ?? []
    expect(shown.lines[0].text).toBe(
      'This workspace can’t reach stablyai/orca on GitHub right now.'
    )
    expect(shown.lines[0].description).toBe('Pulls and pushes won’t work until it can.')
    expect(shown.lines[0].action).toMatchObject({ label: 'Check again' })
    shown.lines[0].action.onClick()
    expect(recheck).toHaveBeenCalledWith('env-1', expect.any(Function))
  })

  it('an owner already asked: the line offers a request to copy for them, never Install', async () => {
    pushAccess.mockResolvedValueOnce('requested')
    setCloudSetupNotices({
      environmentId: 'env-1',
      path: '/w',
      repoId: 'r',
      hostId: null,
      repoUrl: 'https://github.com/acme/web',
      notices: [PUSH]
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText: copyRequest } }
    })
    render(<CloudSetupNoticesDock workspaceId="w1" />)
    await act(async () => {})
    const [, shown] = stack.show.mock.calls.at(-1) ?? []
    expect(shown.lines[0].action).toMatchObject({ label: 'Copy request for an owner' })
    await act(async () => shown.lines[0].action.onClick())
    expect(copyRequest).toHaveBeenCalledWith(
      expect.stringContaining('push from workspaces on this repository')
    )
    expect(copyRequest).toHaveBeenCalledWith(expect.stringContaining('acme/web'))
    const [, copied] = stack.show.mock.calls.at(-1) ?? []
    expect(copied.lines[0].action).toMatchObject({ label: 'Copied' })
  })
})

const PUSH: CloudSetupNotice = {
  id: 'git.push',
  kind: 'push',
  check: { id: 'git.push', category: 'git', status: 'fail', message: 'refused' }
}

const copyRequestHandler = vi.fn()

function line(notice: CloudSetupNotice, access: CloudPushAccess = 'install', repoUrl?: string) {
  return cloudSetupNoticeLine(
    notice,
    { repoUrl: repoUrl ?? 'https://github.com/stablyai/orca' },
    translate,
    {
      push: {
        access,
        install: vi.fn(),
        installing: false,
        copyRequest: copyRequestHandler,
        recheck: vi.fn()
      },
      runSetup: vi.fn()
    }
  )
}

describe('cloudSetupNoticeLine (ENV-NOTICE-ACTIONS)', () => {
  it('low disk: plain words and what to expect, with no button (the disk can’t be grown here)', () => {
    const shown = line({
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
    })
    expect(shown.text).toBe('Only 0.8 GB of disk space is free in this sandbox.')
    expect(shown.description).toBe(
      'Installs and builds may fail. Delete caches or build output you don’t need.'
    )
    expect(shown.action).toBeNull()
  })

  it('a missing tool: names it and what needs it, never the doctor’s label', () => {
    const shown = line({
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
    })
    expect(shown.text).toBe('pnpm isn’t installed in this sandbox, but pnpm-lock.yaml needs it.')
    expect(shown.description).toContain('setup script')
    expect(shown.action).toBeNull()
    // An older server without params: the id still names the tool.
    const older = line({
      id: 'tool.cargo',
      kind: 'tool',
      check: { id: 'tool.cargo', category: 'tools', status: 'fail', message: 'cargo missing' }
    })
    expect(older.text).toBe('cargo isn’t installed in this sandbox.')
  })

  it('push: Install only where installing is possible, and without a Copy link', () => {
    const install = line(PUSH, 'install')
    expect(install.action).toMatchObject({ label: 'Install on stablyai' })
    // No Copy link: the action type has no link field (App installs never get one).

    const blocked = line(PUSH, 'cantInstall', 'https://github.com/octocat/Hello-World')
    expect(blocked.text).toBe('Orca Cloud can read octocat/Hello-World but can’t push to it.')
    expect(blocked.description).toBe(
      'Pushing needs the Orca GitHub App on octocat. Ask an owner of octocat to install it.'
    )
    // No Install: only an owner can. The same Copy request as the requested state.
    expect(blocked.action).toMatchObject({ label: 'Copy request for an owner' })
    expect(blocked.action?.label).not.toContain('Install')
    blocked.action?.run()
    expect(copyRequestHandler).toHaveBeenCalledTimes(1)

    expect(line(PUSH, 'requested').action).toMatchObject({ label: 'Copy request for an owner' })
    expect(line(PUSH, 'granted').action).toMatchObject({ label: 'Check again' })
    for (const access of ['checking', 'unknown'] as const) {
      expect(line(PUSH, access).action).toBeNull()
    }
  })
})
