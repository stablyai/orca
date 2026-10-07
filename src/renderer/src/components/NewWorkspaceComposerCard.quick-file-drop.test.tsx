// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useComposerState } from '@/hooks/useComposerState'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as I18nModule from '@/i18n/i18n'
import type * as ReactI18nextModule from 'react-i18next'

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18nextModule>()),
  useTranslation: () => ({})
}))

const prepare = vi.fn(async ({ paths }: { paths: string[] }) => ({ paths, failures: [] }))
const stat = vi.fn(async () => ({ isDirectory: false }))
const onFileDrop = vi.fn<Window['api']['ui']['onFileDrop']>(() => () => {})
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/drop/${file.name}`,
      prepareDroppedPaths: prepare,
      stat
    },
    ui: { onFileDrop },
    gh: {
      repoSlug: vi.fn(async () => null),
      listWorkItems: vi.fn(async () => ({ items: [], hasMore: false }))
    },
    sparsePresets: { list: vi.fn(async () => []) },
    worktrees: { listRetiredNames: vi.fn(async () => ({ names: [], exhaustedTiers: 0 })) },
    preflight: { detectAgents: vi.fn(async () => []) }
  })
  useAppStore.setState({
    repos: [
      {
        id: 'local-project',
        path: '/project',
        displayName: 'Project',
        badgeColor: 'var(--muted-foreground)',
        addedAt: 0
      }
    ],
    activeRepoId: 'local-project',
    activeModal: 'new-workspace-composer',
    projects: [],
    projectGroups: [],
    projectHostSetups: [],
    newWorkspaceDraft: null,
    worktreesByRepo: {},
    sparsePresetsByRepo: {}
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type FileDragTransfer = { types: string[]; files: File[]; dropEffect: string }

function gesture(target: Element, type: string, transfer: FileDragTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  target.dispatchEvent(event)
}

describe('quick-create modal card without an attachment destination', () => {
  it('refuses an OS drop with the selected local project and does not show an accepting ring', async () => {
    const hook = renderHook(() =>
      useComposerState({
        initialRepoId: 'local-project',
        persistDraft: false
      })
    )
    expect(hook.result.current.cardProps.selectedRepoPath).toBe('/project')
    expect(hook.result.current.cardProps.selectedRepoExecutionHostId).toBe('local')
    const { container } = render(
      <TooltipProvider>
        <NewWorkspaceComposerCard
          {...hook.result.current.cardProps}
          composerRef={hook.result.current.composerRef}
          onComposerNodeChange={hook.result.current.onComposerNodeChange}
          onCreate={() => {}}
          primaryActionLabel="Create workspace"
          quickAgent={null}
          onQuickAgentChange={() => {}}
        />
      </TooltipProvider>
    )
    const card = container.querySelector('[data-workspace-composer-root]')!
    expect(container.querySelector('textarea')?.getAttribute('placeholder')).toBe('Write a note')
    expect(container.querySelector('[data-attachment-path]')).toBeNull()
    const transfer = { types: ['Files'], files: [new File(['x'], 'notes.txt')], dropEffect: 'link' }
    await act(async () => {
      gesture(card, 'dragenter', transfer)
      gesture(card, 'dragover', transfer)
    })
    expect(transfer.dropEffect).toBe('none')
    expect(card.className).not.toContain('ring-2')
    await act(async () => gesture(card, 'drop', transfer))
    expect(prepare).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
    expect(hook.result.current.cardProps.attachmentPaths).toEqual([])
  })
})
