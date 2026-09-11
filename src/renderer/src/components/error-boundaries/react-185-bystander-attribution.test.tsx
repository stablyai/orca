// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RecoverableRenderErrorBoundary } from './RecoverableRenderErrorBoundary'
import { RichMarkdownErrorBoundary } from '@/components/editor/RichMarkdownErrorBoundary'
import { clearReactErrorBoundaryReportingForTest } from '@/lib/react-error-boundary-reporting'

const mocks = vi.hoisted(() => ({ recordRendererError: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const REACT_185_PRODUCTION =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message.'
const UNRELATED_RENDER_ERROR =
  'Minified React error #310; visit https://react.dev/errors/310 for the full message.'

// Every reporting boundary must stamp #185, not just the one nearest the runaway fiber.
const BOUNDARIES: { name: string; boundaryId: string; render: () => ReactElement }[] = [
  {
    name: 'RecoverableRenderErrorBoundary',
    boundaryId: 'page.automations',
    render: () => (
      <RecoverableRenderErrorBoundary boundaryId="page.automations" surface="page">
        <Broken />
      </RecoverableRenderErrorBoundary>
    )
  },
  {
    name: 'RichMarkdownErrorBoundary',
    boundaryId: 'editor.rich-markdown',
    render: () => (
      <RichMarkdownErrorBoundary fileId="notes.md">
        <Broken />
      </RichMarkdownErrorBoundary>
    )
  }
]

let thrownError = new Error('unset')

function Broken(): ReactElement {
  throw thrownError
}

describe('React #185 bystander attribution', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearReactErrorBoundaryReportingForTest()
    mocks.recordRendererError.mockReset()
    mocks.recordRendererError.mockResolvedValue({ ok: true, deduped: false })
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    window.api = {
      crashReports: { recordRendererError: mocks.recordRendererError }
    } as unknown as typeof window.api
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    consoleError.mockRestore()
    vi.unstubAllGlobals()
  })

  async function renderThrowing(element: ReactElement, message: string): Promise<void> {
    thrownError = new Error(message)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(element)
    })
  }

  for (const boundary of BOUNDARIES) {
    it(`stamps unreliable attribution from ${boundary.name}`, async () => {
      await renderThrowing(boundary.render(), REACT_185_PRODUCTION)

      expect(mocks.recordRendererError).toHaveBeenCalledWith(
        expect.objectContaining({ boundaryId: boundary.boundaryId, attribution: 'unreliable' })
      )
    })

    it(`leaves unrelated render errors unattributed from ${boundary.name}`, async () => {
      await renderThrowing(boundary.render(), UNRELATED_RENDER_ERROR)

      expect(mocks.recordRendererError).toHaveBeenCalledTimes(1)
      expect(mocks.recordRendererError.mock.calls[0]?.[0]).not.toHaveProperty('attribution')
    })
  }

  it('stamps the development "Maximum update depth exceeded" message', async () => {
    await renderThrowing(
      BOUNDARIES[0]!.render(),
      'Maximum update depth exceeded. This can happen when a component repeatedly calls setState.'
    )

    expect(mocks.recordRendererError).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: 'unreliable' })
    )
  })
})
