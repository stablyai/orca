// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { Suspense, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffSectionBody } from './DiffSectionBody'

const chunk = vi.hoisted(() => {
  let release: () => void = () => {}
  const loaded = new Promise<void>((resolve) => {
    release = resolve
  })
  return { loaded, release: () => release() }
})

// Holds the lazy chunk pending, like a first open of an image diff in the packaged app.
vi.mock('./ImageDiffViewer', async () => {
  await chunk.loaded
  return { default: () => <div data-testid="image-diff" /> }
})
vi.mock('@monaco-editor/react', () => ({ DiffEditor: () => <div data-testid="monaco-diff" /> }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const props: ComponentProps<typeof DiffSectionBody> = {
  section: {
    key: 'unstaged:z.png',
    path: 'z.png',
    status: 'modified',
    originalContent: '',
    modifiedContent: '',
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: {
      kind: 'binary',
      originalContent: 'b3JpZ2luYWw=',
      modifiedContent: 'bW9kaWZpZWQ=',
      originalIsBinary: true,
      modifiedIsBinary: true,
      isImage: true,
      mimeType: 'image/png'
    },
    largeDiffRenderLimit: null
  },
  index: 7,
  sectionBodyHeight: 300,
  useIntrinsicImageHeight: false,
  isBranchMode: false,
  sideBySide: true,
  isDark: false,
  language: 'plaintext',
  modelPathBase: 'image-suspense',
  isEditable: false,
  diffEditorFontSize: 13,
  onRetrySection: vi.fn(),
  onLoadDeferredSection: vi.fn(),
  onSaveLimitedDiff: vi.fn(),
  onMount: vi.fn()
}

afterEach(() => {
  cleanup()
})

describe('DiffSectionBody image chunk loading', () => {
  it('keeps the image chunk suspension inside the row so the diff list stays mounted', async () => {
    render(
      <Suspense fallback={<div data-testid="editor-fallback" />}>
        <div data-testid="diff-list-sibling" />
        <DiffSectionBody {...props} />
      </Suspense>
    )

    // Why: the outer fallback hides the virtualized list, which is the hide/re-show
    // cycle that looped into React #185 in the combined diff.
    expect(screen.queryByTestId('editor-fallback')).toBeNull()
    expect(screen.getByTestId('diff-list-sibling').style.display).not.toBe('none')

    await act(async () => {
      chunk.release()
      await chunk.loaded
    })
    expect(await screen.findByTestId('image-diff')).toBeTruthy()
    expect(screen.queryByTestId('editor-fallback')).toBeNull()
  })
})
