import type * as LocalImageSource from '@/components/editor/useLocalImageSrc'
// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getRevealInFileManagerLabel } from '@/lib/reveal-in-file-manager'
import { NativeChatMarkdownImage } from './NativeChatMarkdownImage'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'

vi.mock('@/components/editor/useLocalImageSrc', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalImageSource>()),
  useLocalImageSrc: () => 'blob:original'
}))
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) })
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const localOwner = {
  fileLinkContext: {
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    runtimeEnvironmentId: null,
    sourceTabId: 'tab-1'
  },
  runtimeContext: {
    target: { kind: 'local' as const },
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    expectedExecutionHostId: 'local' as const
  },
  isVisible: true
}

describe('native chat image action ownership', () => {
  it.each(
    [
      {
        name: 'client-local',
        runtimeContext: localOwner.runtimeContext,
        canOpenLocally: true
      },
      {
        name: 'paired server',
        runtimeContext: {
          ...localOwner.runtimeContext,
          target: { kind: 'environment' as const, environmentId: 'env-1' }
        },
        canOpenLocally: false
      },
      {
        name: 'SSH execution host on a local transport',
        runtimeContext: {
          ...localOwner.runtimeContext,
          expectedExecutionHostId: 'ssh:ssh-1' as const
        },
        canOpenLocally: false
      }
    ].map(({ runtimeContext, ...testCase }) => ({
      ...testCase,
      owner: { ...localOwner, runtimeContext }
    }))
  )(
    'limits OS image actions to the client for a $name image',
    async ({ owner, canOpenLocally }) => {
      const user = userEvent.setup()
      render(
        <TooltipProvider>
          <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
            <NativeChatMarkdownImage src="screenshots/chart.png" alt="Chart" />
          </NativeChatMarkdownImageOwnerContext.Provider>
        </TooltipProvider>
      )
      await screen.findByRole('img', { name: 'Chart' })
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
      await user.click(screen.getByRole('button', { name: 'Image actions' }))

      expect(screen.queryByRole('menuitem', { name: getRevealInFileManagerLabel() }) !== null).toBe(
        canOpenLocally
      )
      expect(screen.queryByRole('menuitem', { name: 'Open with default app' }) !== null).toBe(
        canOpenLocally
      )
      expect(screen.getByRole('menuitem', { name: 'Copy image path' })).toBeInTheDocument()
    }
  )
})
