// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DiffViewer from '@/components/editor/diff/monaco-view/DiffViewer'

let latestAutoFocusHost: boolean | undefined
let latestCollapseUnchanged: boolean | undefined
const fixture = vi.hoisted(() => ({ settings: { diffCollapseUnchangedRegions: true } }))

vi.mock('@/store', () => {
  const state = {
    settings: fixture.settings,
    addDiffComment: () => {},
    deleteDiffComment: () => {},
    updateDiffComment: () => {}
  }
  return { useAppStore: (selector: (s: typeof state) => unknown) => selector(state) }
})
vi.mock('@/components/editor/commands/editor-shortcuts', () => ({
  installEditorSaveShortcut: () => () => {}
}))
vi.mock('@/components/editor/diff/review/diff-navigation-context', () => ({
  useDiffNavigatorRegistration: () => ({
    registerDiffNavigator: () => {},
    unregisterDiffNavigator: () => {}
  })
}))
vi.mock('./pierre-diff/use-pierre-file-diff', () => ({
  usePierreFileDiff: () => ({
    fileDiff: { name: 'file.ts', hunks: [] },
    error: null,
    retry: () => {},
    markEdited: () => {},
    editReady: true
  })
}))
vi.mock('./pierre-diff/PierreDiffProviders', () => ({
  PierreDiffProviders: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('./pierre-diff/PierreDiffSurface', () => ({
  PierreDiffSurface: (props: { autoFocusHost?: boolean; collapseUnchanged: boolean }) => {
    latestAutoFocusHost = props.autoFocusHost
    latestCollapseUnchanged = props.collapseUnchanged
    return null
  }
}))

afterEach(() => {
  cleanup()
  latestAutoFocusHost = undefined
})

it('asks the Pierre host to take focus the way Monaco did on DiffViewer mount', () => {
  const surface = () => (
    <DiffViewer
      modelKey="file"
      originalContent="old"
      modifiedContent="new"
      relativePath="file.ts"
      filePath="file.ts"
      language="typescript"
      sideBySide={false}
    />
  )
  const view = render(surface())
  expect(latestAutoFocusHost).toBe(true)
  expect(latestCollapseUnchanged).toBe(true)
  fixture.settings.diffCollapseUnchangedRegions = false
  view.rerender(surface())
  expect(latestCollapseUnchanged).toBe(false)
})
