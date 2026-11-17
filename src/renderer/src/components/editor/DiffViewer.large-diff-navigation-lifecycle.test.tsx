// @vitest-environment happy-dom
import { cleanup, render, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DiffViewer from '@/components/editor/diff/monaco-view/DiffViewer'
import {
  DiffNavigationProvider,
  useDiffNavigation
} from '@/components/editor/diff/review/diff-navigation-context'
import { getLargeDiffRenderLimitFromCounts } from '../../../../shared/source-control/diff/large-diff-render-limit'
import { buildPierreFileDiff, type PierreDiffInput } from './pierre-diff/pierre-diff-metadata'

const fileDiff = buildPierreFileDiff({
  path: 'README.md',
  status: 'modified',
  originalContent: 'original',
  modifiedContent: 'modified',
  parseDiffOptions: {}
})

const fixture = vi.hoisted(() => ({
  scroll: vi.fn(),
  state: { settings: { diffWordWrap: true } }
}))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: typeof fixture.state) => T) => selector(fixture.state)
}))
vi.mock('./pierre-diff/use-pierre-file-diff', () => ({
  usePierreFileDiff: (input: PierreDiffInput | null) => ({
    fileDiff: input ? fileDiff : null,
    error: null,
    retry: vi.fn(),
    markEdited: vi.fn(),
    editReady: true
  })
}))
vi.mock('./pierre-diff/PierreDiffSurface', () => ({ PierreDiffSurface: () => <div>Diff</div> }))
vi.mock('./pierre-diff/PierreDiffProviders', () => ({
  PierreDiffProviders: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('./pierre-diff/use-pierre-diff-scroll-restore', () => ({
  usePierreDiffScrollRestore: () => vi.fn()
}))
vi.mock('./pierre-diff/pierre-diff-scroll', () => ({ scrollPierreDiffToLine: fixture.scroll }))
vi.mock('@/components/editor/commands/editor-shortcuts', () => ({
  installDiffChangeNavigationShortcut: () => vi.fn()
}))
vi.mock('@/components/editor/diff/large-files/LargeDiffFallback', () => ({
  LargeDiffFallback: () => <div>Large diff</div>
}))

function NavigationProbe() {
  const navigation = useDiffNavigation()
  return (
    <button disabled={navigation.changeCount === 0} onClick={navigation.goToNextDiff}>
      Next change ({navigation.changeCount})
    </button>
  )
}

function Surface({ limited }: { limited: boolean }) {
  return (
    <DiffNavigationProvider>
      <NavigationProbe />
      <DiffViewer
        modelKey="navigation-lifecycle"
        originalContent="original"
        modifiedContent="modified"
        language="markdown"
        filePath="README.md"
        relativePath="README.md"
        sideBySide
        largeDiffRenderLimit={getLargeDiffRenderLimitFromCounts({
          originalLineCount: limited ? 120_001 : 1,
          modifiedLineCount: 1,
          originalCharacterCount: 8,
          modifiedCharacterCount: 8
        })}
      />
    </DiffNavigationProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('unregisters change navigation while a large diff is gated and restores it on return', () => {
  const view = render(<Surface limited={false} />)
  const next = view.getByRole('button', { name: 'Next change (1)' })
  expect(next.hasAttribute('disabled')).toBe(false)
  fireEvent.click(next)
  expect(fixture.scroll).toHaveBeenCalledOnce()

  view.rerender(<Surface limited />)
  expect(view.getByText('Large diff')).toBeDefined()
  const gated = view.getByRole('button', { name: 'Next change (0)' })
  expect(gated.hasAttribute('disabled')).toBe(true)
  fireEvent.click(gated)
  expect(fixture.scroll).toHaveBeenCalledOnce()

  view.rerender(<Surface limited={false} />)
  fireEvent.click(view.getByRole('button', { name: 'Next change (1)' }))
  expect(fixture.scroll).toHaveBeenCalledTimes(2)
})
