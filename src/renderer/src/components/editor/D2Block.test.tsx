// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { D2RenderRequest, D2RenderResult } from '../../../../shared/d2-render-types'
import D2Block from './D2Block'

const renderD2 = vi.fn<(args: D2RenderRequest) => Promise<D2RenderResult>>()
const sanitize = vi.hoisted(() => vi.fn((svg: string) => svg.replace('<script>x</script>', '')))
vi.mock('dompurify', () => ({ default: { sanitize } }))

beforeEach(() => {
  renderD2.mockReset()
  vi.stubGlobal('api', { d2: { render: renderD2 } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('D2Block', () => {
  it('shows the diagram only after sanitizing it as SVG', async () => {
    renderD2.mockResolvedValue({ ok: true, svg: '<b>diagram</b><script>x</script>' })
    const { container } = render(<D2Block content="a -> b" isDark />)
    expect(await screen.findByText('diagram')).toBeVisible()
    expect(renderD2).toHaveBeenCalledWith({ source: 'a -> b', isDark: true })
    expect(sanitize).toHaveBeenCalledWith('<b>diagram</b><script>x</script>', {
      USE_PROFILES: { svg: true, svgFilters: true }
    })
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })

  it('keeps the source visible with a hint when d2 is not installed', async () => {
    renderD2.mockResolvedValue({ ok: false, reason: 'missing' })
    render(<D2Block content="a -> b" isDark={false} />)
    expect(await screen.findByText('Install the d2 CLI to render this diagram.')).toBeVisible()
    expect(screen.getByText('a -> b')).toBeVisible()
  })

  it('keeps the source visible with the error when d2 rejects the diagram', async () => {
    renderD2.mockResolvedValue({ ok: false, reason: 'error', message: '1:1: missing destination' })
    render(<D2Block content="a ->" isDark={false} />)
    expect(await screen.findByText(/1:1: missing destination/)).toBeVisible()
    expect(screen.getByText('a ->')).toBeVisible()
  })

  it('shows only the source where rendering is unavailable', async () => {
    renderD2.mockResolvedValue({ ok: false, reason: 'unavailable' })
    const { container } = render(<D2Block content="a -> b" isDark={false} />)
    await waitFor(() => expect(renderD2).toHaveBeenCalled())
    expect(screen.getByText('a -> b')).toBeVisible()
    expect(container.querySelector('.d2-hint, .d2-error')).toBeNull()
  })

  it('omits the source and renders nothing when there is nothing to report', async () => {
    renderD2.mockResolvedValue({ ok: false, reason: 'error', message: 'bad' })
    const { container, rerender } = render(<D2Block content="a ->" isDark showSource={false} />)
    expect(await screen.findByText(/bad/)).toBeVisible()
    expect(container.querySelector('pre')).toBeNull()
    renderD2.mockResolvedValue({ ok: false, reason: 'unavailable' })
    rerender(<D2Block content="a -> b" isDark showSource={false} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
