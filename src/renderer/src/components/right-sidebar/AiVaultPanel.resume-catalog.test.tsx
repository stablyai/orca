// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as NewWorkspace from '@/lib/new-workspace'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo } from '../../../../shared/repo-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { launchAiVaultSessionAndReveal } from '@/lib/launch-ai-vault-session-and-reveal'
import { resetAiVaultForcedRescanThrottleForTest } from './ai-vault-session-refresh'
import AiVaultPanel from './AiVaultPanel'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'

vi.mock('@/lib/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof NewWorkspace>()),
  CLIENT_PLATFORM: 'win32'
}))
vi.mock('@/lib/launch-ai-vault-session-and-reveal', () => ({
  launchAiVaultSessionAndReveal: vi.fn().mockResolvedValue(undefined)
}))
// happy-dom has no viewport measurements; retain the actual list, rows and actions.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 80,
        end: (index + 1) * 80,
        size: 80
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollOffset: 0
  })
}))

const original = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  vi.clearAllMocks()
})

it('uses the mounted panel catalog for Resume eligibility and the concrete action target', async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetAiVaultForcedRescanThrottleForTest()
  const repo: Repo = { id: 'b', path: 'C:/app-b', displayName: 'B', badgeColor: '', addedAt: 1 }
  const worktree = makeWorktree({
    id: 'b::C:/app-b',
    repoId: 'b',
    path: 'C:/app-b',
    hostId: 'local'
  })
  const catalog = projectHostSetupProjectionFromRepos([repo])
  useAppStore.setState({
    repos: [repo],
    activeRepoId: 'b',
    activeWorktreeId: worktree.id,
    endpointProjects: catalog.projects.map((project) => ({
      ...project,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })),
    endpointProjectHostSetups: [...catalog.setups],
    worktreesByRepo: { b: [worktree] },
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'windows-host' },
      terminalWindowsShell: 'powershell.exe'
    }
  })
  const wsl: AiVaultSession = {
    id: 'claude:wsl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'wsl-session',
    title: 'Ubuntu conversation',
    cwd: 'C:/app-b',
    branch: null,
    model: null,
    filePath: String.raw`\\wsl.localhost\Ubuntu\home\alice\.claude\projects\app\wsl-session.jsonl`,
    codexHome: null,
    createdAt: '2026-10-23T10:00:00Z',
    updatedAt: '2026-10-23T10:00:00Z',
    modifiedAt: '2026-10-23T10:00:00Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [{ role: 'user', text: 'continue this work', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
  const native: AiVaultSession = {
    ...wsl,
    id: 'claude:native',
    sessionId: 'native-session',
    title: 'Windows conversation',
    filePath: 'C:/Users/alice/.claude/projects/app/native-session.jsonl'
  }
  const prepare = vi
    .fn<Window['api']['aiVault']['prepareSessionResume']>()
    .mockResolvedValue({ useRealCodexHome: false })
  const listSessions = vi.fn<Window['api']['aiVault']['listSessions']>().mockResolvedValue({
    sessions: [wsl, native],
    issues: [],
    scannedAt: '2026-10-23T10:00:00Z'
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions,
        prepareSessionResume: prepare,
        cancelListSessions: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
  render(
    <ConfirmationDialogContext value={async () => false}>
      <TooltipProvider>
        <AiVaultPanel />
      </TooltipProvider>
    </ConfirmationDialogContext>
  )
  const resumeButton = (title: string) => {
    const row = screen.getByText(title).closest('.ai-vault-session-row')
    if (!(row instanceof HTMLElement)) {
      throw new Error('Expected the real session row')
    }
    return within(row).getByRole('button', { name: /^Resume in / })
  }
  await waitFor(() => expect(screen.getByText(wsl.title)).toBeTruthy())
  expect(resumeButton(wsl.title).hasAttribute('disabled')).toBe(false)
  expect(resumeButton(native.title).hasAttribute('disabled')).toBe(true)
  fireEvent.click(resumeButton(wsl.title))
  await waitFor(() => expect(launchAiVaultSessionAndReveal).toHaveBeenCalledOnce())
  expect(prepare).toHaveBeenCalledWith({
    agent: 'claude',
    sessionId: wsl.sessionId,
    executionHostId: 'local',
    filePath: wsl.filePath,
    codexHome: null
  })
  expect(launchAiVaultSessionAndReveal).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      worktreeId: worktree.id,
      command: expect.stringContaining("'wsl-session'")
    }),
    expect.any(Function)
  )
  expect(useAppStore.getState().repos[0]).toBe(repo)
  expect(useAppStore.getState().worktreesByRepo.b[0]).toMatchObject({
    path: 'C:/app-b',
    hostId: 'local'
  })
  act(() =>
    useAppStore.setState((state) => ({
      endpointProjects: state.endpointProjects.map((project) => ({
        ...project,
        localWindowsRuntimePreference: { kind: 'windows-host' }
      }))
    }))
  )
  await waitFor(() => expect(resumeButton(wsl.title).hasAttribute('disabled')).toBe(true))
  expect(resumeButton(native.title).hasAttribute('disabled')).toBe(false)
  fireEvent.click(resumeButton(wsl.title))
  expect(launchAiVaultSessionAndReveal).toHaveBeenCalledOnce()
})
