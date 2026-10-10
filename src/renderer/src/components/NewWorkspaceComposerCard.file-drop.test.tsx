// @vitest-environment happy-dom
import type * as ReactI18nextModule from 'react-i18next'
import { act, renderHook } from '@testing-library/react'
import { useNewWorkspaceComposerFileDrop } from './new-workspace/use-new-workspace-composer-file-drop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'
import { createRef } from 'react'
import { resolveComposerAttachmentTarget } from '../hooks/composer-state/composer-attachment-target'
import { useAttachmentDropState } from '../hooks/composer-state/attachment-drop-state'
import type { ProjectGroup } from '../../../shared/project-group-types'

const uploads = vi.hoisted(() => ({ importPaths: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: uploads.importPaths
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ settings: {}, projects: [], repos: [] }),
    {
      getState: () => ({
        sshConnectionStates: connections,
        sshStateByEnvironment: runtimeConnections
      })
    }
  )
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18nextModule>()),
  useTranslation: () => ({})
}))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('./new-workspace/NewWorkspaceComposerProjectSection', () => ({
  NewWorkspaceComposerProjectSection: () => null
}))
vi.mock('./new-workspace/NewWorkspaceComposerNameSection', () => ({
  NewWorkspaceComposerNameSection: () => null
}))
vi.mock('./new-workspace/NewWorkspaceComposerAgentSection', () => ({
  NewWorkspaceComposerAgentSection: () => null
}))
vi.mock('./new-workspace/NewWorkspaceComposerAdvancedSection', () => ({
  NewWorkspaceComposerAdvancedSection: () => null
}))
vi.mock('./new-workspace/NewWorkspaceComposerFooter', () => ({
  NewWorkspaceComposerFooter: () => <textarea />
}))

const runtimeConnections = vi.hoisted(
  () => new Map<string, { connectionStates: Map<string, { connectionGeneration: number }> }>()
)
const connections = vi.hoisted(() => new Map<string, { connectionGeneration: number }>())
const prepare = vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] }))
const cards: HTMLDivElement[] = []
beforeEach(() => {
  vi.clearAllMocks()
  connections.clear()
  runtimeConnections.clear()
  uploads.importPaths.mockResolvedValue({
    results: [
      {
        status: 'imported',
        destPath: '/folder/.orca/drops/a.txt',
        kind: 'file'
      }
    ]
  })
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/drop/${file.name}`,
      prepareDroppedPaths: prepare
    }
  })
})
afterEach(() => {
  for (const card of cards.splice(0)) {
    unmountCard(card)
  }
  vi.unstubAllGlobals()
})
async function card(
  attach: (paths: string[], current: () => boolean) => Promise<void>,
  path = '/repo'
) {
  const container = await renderCard({
    selectedRepoPath: path,
    selectedRepoExecutionHostId: 'local',
    onNativeFileDrop: attach,
    projectHostSetupOptions: []
  })
  cards.push(container)
  return container
}
async function drop(container: HTMLDivElement) {
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files: [new File(['x'], 'a.txt')] }
  })
  await act(async () => {
    container.querySelector('textarea')!.dispatchEvent(event)
  })
}
describe('new workspace card file drop ownership', () => {
  it.each([
    ['/folder/source-repo', false],
    ['/outside/source-repo', false],
    ['/folder/source-repo', true],
    ['/outside/source-repo', true]
  ] as const)(
    'uploads into the selected folder project with task source %s (changes during preparation: %s)',
    async (sourcePath, changesSource) => {
      const attach = vi.fn()
      const group: ProjectGroup = {
        id: 'folder-project',
        name: 'Folder',
        parentPath: '/folder',
        connectionId: 'ssh-a',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }
      connections.set('ssh-a', { connectionGeneration: 1 })
      const initialProps: { source: string } = { source: sourcePath }
      const hook = renderHook(
        ({ source }: { source: string }) => {
          const target = resolveComposerAttachmentTarget({
            selectedProjectGroup: group,
            selectedRepo: { id: 'source-repo' },
            selectedRepoPath: source,
            selectedRepoExecutionHostId: 'ssh:ssh-a',
            selectedRepoSettings: {},
            connectionId: 'ssh-a'
          })
          const dropState = useAttachmentDropState({
            agentPromptRef: { current: '' },
            cancelPromptCaretFrame: () => {},
            promptCaretFrameRef: { current: null },
            promptTextareaRef: createRef<HTMLTextAreaElement>(),
            connectionId: target.connectionId,
            selectedRepoPath: target.path ?? undefined,
            selectedRepoSettings: target.settings,
            selectedWorktreeId: target.worktreeId,
            setAgentPrompt: () => {},
            setAttachmentPaths: attach
          })
          return useNewWorkspaceComposerFileDrop({
            projectPath: target.path,
            hostId: target.hostId,
            connectionId: target.connectionId,
            applyDrop: dropState.applyNativeDrop
          })
        },
        { initialProps }
      )
      const owner = document.createElement('div')
      const textarea = document.createElement('textarea')
      owner.append(textarea)
      document.body.append(owner)
      act(() => hook.result.current(owner))
      try {
        const gate = Promise.withResolvers<{ paths: string[]; failures: never[] }>()
        prepare.mockImplementationOnce(() => gate.promise)
        await drop(owner)
        if (changesSource) {
          hook.rerender({ source: '/different-task-source' })
        }
        await act(async () => gate.resolve({ paths: ['/drop/a.txt'], failures: [] }))
        expect(uploads.importPaths).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ worktreePath: '/folder', connectionId: 'ssh-a' }),
          ['/drop/a.txt'],
          '/folder/.orca/drops',
          expect.any(Object)
        )
        expect(attach).toHaveBeenCalledOnce()
      } finally {
        act(() => hook.result.current(null))
        hook.unmount()
        owner.remove()
      }
    }
  )
  it('delivers to the card under the cursor even when another card mounts later', async () => {
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    const a = await card(first, '/repo-a')
    const b = await card(second, '/repo-b')
    await drop(a)
    expect(first).toHaveBeenCalledExactlyOnceWith(['/drop/a.txt'], expect.any(Function))
    expect(second).not.toHaveBeenCalled()
    await drop(b)
    expect(second).toHaveBeenCalledExactlyOnceWith(['/drop/a.txt'], expect.any(Function))
    unmountCard(b)
    cards.splice(cards.indexOf(b), 1)
    await drop(a)
    expect(first).toHaveBeenCalledTimes(2)
  })
  it('keeps a preparation captured for the original card when another card mounts', async () => {
    const gate = Promise.withResolvers<{ paths: string[]; failures: never[] }>()
    prepare.mockImplementationOnce(() => gate.promise)
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    const a = await card(first)
    await drop(a)
    await card(second)
    await act(async () => gate.resolve({ paths: ['/prepared/a.txt'], failures: [] }))
    expect(first).toHaveBeenCalledExactlyOnceWith(['/prepared/a.txt'], expect.any(Function))
    expect(second).not.toHaveBeenCalled()
  })
  it('abandons a preparation when its card unmounts', async () => {
    const gate = Promise.withResolvers<{ paths: string[]; failures: never[] }>()
    prepare.mockImplementationOnce(() => gate.promise)
    const attach = vi.fn(async () => {})
    const a = await card(attach)
    await drop(a)
    unmountCard(a)
    cards.splice(cards.indexOf(a), 1)
    await act(async () => gate.resolve({ paths: ['/prepared/a.txt'], failures: [] }))
    expect(attach).not.toHaveBeenCalled()
  })
  it.each(['project', 'host', 'connection', 'runtime connection'] as const)(
    'refuses a captured destination after its %s changes',
    async (change) => {
      const gate = Promise.withResolvers<{ paths: string[]; failures: never[] }>()
      prepare.mockImplementationOnce(() => gate.promise)
      const applyDrop = vi.fn(async () => {})
      connections.set('ssh-a', { connectionGeneration: 1 })
      runtimeConnections.set('runtime-a', {
        connectionStates: new Map([['ssh-a', { connectionGeneration: 1 }]])
      })
      const input: Parameters<typeof useNewWorkspaceComposerFileDrop>[0] = {
        projectPath: '/repo',
        hostId: change === 'runtime connection' ? 'runtime:runtime-a' : 'ssh:ssh-a',
        connectionId: 'ssh-a',
        applyDrop
      }
      const hook = renderHook(
        (args: Parameters<typeof useNewWorkspaceComposerFileDrop>[0]) =>
          useNewWorkspaceComposerFileDrop(args),
        { initialProps: input }
      )
      const owner = document.createElement('div')
      const target = document.createElement('textarea')
      owner.append(target)
      document.body.append(owner)
      act(() => hook.result.current(owner))
      const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
      Object.defineProperty(event, 'isTrusted', { value: true })
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: [new File(['x'], 'a.txt')] }
      })
      await act(async () => target.dispatchEvent(event))
      if (change === 'runtime connection') {
        runtimeConnections.set('runtime-a', {
          connectionStates: new Map([['ssh-a', { connectionGeneration: 2 }]])
        })
      } else if (change === 'connection') {
        connections.set('ssh-a', { connectionGeneration: 2 })
      } else {
        hook.rerender({
          ...input,
          projectPath: change === 'project' ? '/other' : input.projectPath,
          hostId: change === 'host' ? 'local' : input.hostId
        })
      }
      await act(async () => gate.resolve({ paths: ['/prepared/a.txt'], failures: [] }))
      expect(applyDrop).not.toHaveBeenCalled()
      act(() => hook.result.current(null))
      hook.unmount()
      owner.remove()
    }
  )
})
