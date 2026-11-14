import { beforeEach, describe, expect, it, vi } from 'vitest'

const restartCloudWorkspace = vi.hoisted(() => vi.fn())
type ToastOptions = {
  description?: string
  action?: { label: string; onClick: () => void }
}
const toastError = vi.hoisted(() => vi.fn<(title: string, options: ToastOptions) => void>())
const connectCurrentOrcaProfile = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: toastError, dismiss: vi.fn(), success: vi.fn() })
}))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ connectCurrentOrcaProfile }) }
}))
vi.mock('@/lib/orca-cloud/orca-cloud-workspace-actions', () => ({
  archiveCloudWorkspace: vi.fn(),
  restartCloudWorkspace,
  unarchiveCloudWorkspace: vi.fn()
}))
vi.mock('@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow', () => ({
  runSleepWorktree: vi.fn()
}))
vi.mock('@/lib/workspace/activation/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: vi.fn()
}))
vi.mock('@/lib/orca-cloud/open-cloud-console', () => ({ openCloudConsole: vi.fn() }))

import { translate } from '@/i18n/i18n'
import {
  describeError,
  describeInlineError
} from '@/components/cloud-workspaces/cloud-workspace-errors'
import { runRestartCloudWorkspace } from '@/components/orca-cloud/cloud-workspace-actions'
import { shareErrorMessage } from '@/components/right-sidebar/cloud-share/share-link-status'
import { cloudSecretsErrorCopy } from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import { signInAgainActionLabel, signInAgainMessage } from './orca-sign-in-again'

const SENTENCE = 'Sign in to Orca again to continue.'

describe('unauthorized copy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is one sentence with one action label', () => {
    expect(signInAgainMessage()).toBe(SENTENCE)
    expect(signInAgainActionLabel()).toBe('Sign in')
  })

  it.each([
    ['cloud workspace error', () => describeError('unauthorized')],
    ['cloud workspace inline error', () => describeInlineError('unauthorized')],
    ['share link error', () => shareErrorMessage('unauthorized')],
    ['cloud secrets error', () => cloudSecretsErrorCopy('unauthorized', translate)]
  ])('the %s says the same thing', (_surface, copy) => {
    expect(copy()).toBe(SENTENCE)
  })

  it('the lifecycle toast says it and offers Sign in', async () => {
    restartCloudWorkspace.mockResolvedValue({ ok: false, code: 'unauthorized' })
    await runRestartCloudWorkspace('ws-1')
    expect(toastError).toHaveBeenCalledTimes(1)
    const [, options] = toastError.mock.calls[0]
    expect(options.description).toBe(SENTENCE)
    expect(options.action?.label).toBe('Sign in')
    options.action?.onClick()
    expect(connectCurrentOrcaProfile).toHaveBeenCalledTimes(1)
  })

  it('other lifecycle failures offer no Sign in', async () => {
    restartCloudWorkspace.mockResolvedValue({ ok: false, code: 'unavailable' })
    await runRestartCloudWorkspace('ws-1')
    const [, options] = toastError.mock.calls[0]
    expect(options.action).toBeUndefined()
  })
})
