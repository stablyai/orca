// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DiffViewer from './DiffViewer'

let latestAutoFocusHost: boolean | undefined

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: object) => unknown) =>
    selector({
      settings: {},
      addDiffComment: () => {},
      deleteDiffComment: () => {},
      updateDiffComment: () => {}
    })
}))
vi.mock('./editor-shortcuts', () => ({ installEditorSaveShortcut: () => () => {} }))
vi.mock('./diff-navigation-context', () => ({
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
  PierreDiffSurface: (props: { autoFocusHost?: boolean }) => {
    latestAutoFocusHost = props.autoFocusHost
    return null
  }
}))

afterEach(() => {
  cleanup()
  latestAutoFocusHost = undefined
})

it('asks the Pierre host to take focus the way Monaco did on DiffViewer mount', () => {
  render(
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
  expect(latestAutoFocusHost).toBe(true)
})
