// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { getLocalCommandSourcePolicyNotice, RepositoryHooksSection } from './RepositoryHooksSection'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: {},
      settingsSearchQuery: ''
    })
}))

vi.mock('@/runtime/runtime-hooks-client', () => ({
  readRuntimeIssueCommand: vi.fn().mockResolvedValue({ command: '', exists: false }),
  writeRuntimeIssueCommand: vi.fn().mockResolvedValue(undefined)
}))

const repo: Repo = {
  id: 'repo-1',
  kind: 'git',
  path: '/workspace/repo',
  displayName: 'Repo',
  badgeColor: 'blue',
  addedAt: 1,
  gitUsername: ''
}

function renderRepositoryHooksSection(args: {
  onUpdateHookSettings: (settings: NonNullable<Repo['hookSettings']>) => void
}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      React.createElement(RepositoryHooksSection, {
        repo,
        yamlHooks: null,
        hasHooksFile: false,
        hooksInspectionReady: true,
        mayNeedUpdate: false,
        copiedTemplate: false,
        forceVisible: true,
        onCopyTemplate: () => {},
        onUpdateHookSettings: args.onUpdateHookSettings
      })
    )
  })
  return { container, root }
}

let rendered: { container: HTMLDivElement; root: Root } | null = null

afterEach(() => {
  act(() => rendered?.root.unmount())
  rendered?.container.remove()
  rendered = null
})

describe('getLocalCommandSourcePolicyNotice', () => {
  it('does not show a notice when no local scripts are saved', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: '',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toBeNull()
  })

  it('does not show a notice when command source already includes local scripts', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'local-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: true
      })
    ).toBeNull()

    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'run-both',
        setupScript: '',
        archiveScript: 'echo archive',
        hasSharedScript: true
      })
    ).toBeNull()
  })

  it('waits for hook inspection before recommending a command source', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: false,
        currentPolicy: 'shared-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toEqual({ kind: 'checking' })
  })

  it('recommends local commands when local scripts are saved and no shared script exists', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toEqual({ kind: 'action', policy: 'local-only', label: 'Use local commands' })
  })

  it('recommends run-both when local and shared scripts both exist', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: '',
        archiveScript: 'echo archive',
        hasSharedScript: true
      })
    ).toEqual({ kind: 'action', policy: 'run-both', label: 'Run both' })
  })
})

describe('RepositoryHooksSection setup startup policy', () => {
  it('persists wait-for-setup when the repository toggle is checked', () => {
    const updates: NonNullable<Repo['hookSettings']>[] = []
    rendered = renderRepositoryHooksSection({
      onUpdateHookSettings: (settings) => updates.push(settings)
    })

    const waitSwitch = rendered.container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Wait for setup to complete before starting agent"]'
    )
    expect(waitSwitch).toBeTruthy()

    act(() => waitSwitch?.click())

    expect(updates.at(-1)).toMatchObject({
      setupAgentStartupPolicy: 'wait-for-setup',
      setupRunPolicy: 'run-by-default',
      scripts: { setup: '', archive: '' }
    })
  })
})
