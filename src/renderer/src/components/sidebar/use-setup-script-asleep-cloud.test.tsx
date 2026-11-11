// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const recovery = vi.hoisted(() => {
  const value: { asleep: boolean } = { asleep: false }
  return value
})

vi.mock('@/lib/orca-cloud/use-cloud-recovery-context', () => ({
  useCloudRecoveryContext: (worktreeId: string | null | undefined) =>
    worktreeId ? { waking: false, asleep: recovery.asleep, workspaceName: null } : null
}))

import { useSetupScriptAsleepCloud } from './use-setup-script-asleep-cloud'
import {
  clearWorktreeGoingToSleep,
  holdWorktreeSleepView,
  markWorktreeGoingToSleep,
  releaseWorktreeSleepView,
  resetWorktreeSleepViewForTests
} from '@/lib/worktree-sleep-view'

describe('the setup-script check waits for an Orca Cloud workspace that is asleep', () => {
  afterEach(() => {
    cleanup()
    resetWorktreeSleepViewForTests()
    recovery.asleep = false
  })

  it('from the Sleep click on, not only once the sandbox reads asleep', () => {
    const { result } = renderHook(() => useSetupScriptAsleepCloud('ws'))
    expect(result.current).toBe(false)
    act(() => markWorktreeGoingToSleep('ws'))
    expect(result.current).toBe(true)
    act(() => {
      clearWorktreeGoingToSleep('ws')
      holdWorktreeSleepView('ws')
    })
    expect(result.current).toBe(true)
    act(() => releaseWorktreeSleepView('ws'))
    expect(result.current).toBe(false)
  })

  it('still waits for an asleep one (RA-12), and ignores other workspaces going to sleep', () => {
    const { result, rerender } = renderHook(() => useSetupScriptAsleepCloud('ws'))
    act(() => markWorktreeGoingToSleep('other'))
    expect(result.current).toBe(false)
    recovery.asleep = true
    rerender()
    expect(result.current).toBe(true)
  })
})
