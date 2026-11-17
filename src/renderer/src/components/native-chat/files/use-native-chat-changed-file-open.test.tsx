// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { NativeChatFileOpenContext } from '../links/actions/native-chat-link-click-context'
import type { NativeChatFileOpener } from '../links/actions/use-native-chat-file-link-click'
import { useNativeChatChangedFileOpen } from './use-native-chat-changed-file-open'

const opener: NativeChatFileOpener = {
  worktreeId: 'wt-1',
  resolvePath: (href) => `/repo/${decodeURIComponent(href.slice(href.indexOf(':') + 1))}`,
  destinationFor: () => 'editor',
  open: () => {}
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return <NativeChatFileOpenContext value={opener}>{children}</NativeChatFileOpenContext>
}

/** Renders one card's open action and counts its renders across a workspace catalog change. */
function rendersAcrossCatalogChange(path: string): number {
  let renders = 0
  renderHook(
    () => {
      renders += 1
      return useNativeChatChangedFileOpen(path)
    },
    { wrapper }
  )
  const before = renders
  act(() => {
    useAppStore.setState({ projectGroups: [...useAppStore.getState().projectGroups] })
  })
  return renders - before
}

afterEach(() => cleanup())

describe('changed-file card open action in a long transcript', () => {
  it('does not rerender a non-page row when the workspace catalog changes', () => {
    expect(rendersAcrossCatalogChange('src/app.ts')).toBe(0)
  })

  it('keeps a page row following the catalog that decides its Orca Browser label', () => {
    expect(rendersAcrossCatalogChange('site/index.html')).toBe(1)
  })
})
