// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationRunOutput } from '../../../../shared/automation-run-result-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AutomationRunResults, type AutomationRunOutputActions } from './AutomationRunResults'
import { makeRun } from './automations-page-fixtures'

const run = makeRun()
const output: AutomationRunOutput = {
  id: 'o1',
  title: 'Notes',
  format: 'markdown',
  bytes: 7,
  attachedAt: 1
}

function results(current: AutomationRun, actions?: Partial<AutomationRunOutputActions>) {
  return (
    <TooltipProvider>
      <AutomationRunResults
        run={current}
        actions={{
          load: async () => 'Preview body',
          open: async () => {},
          download: async () => {},
          ...actions
        }}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('AutomationRunResults', () => {
  it('says nothing was reported only when the agent was asked to report', () => {
    const { container, rerender } = render(results(run))
    expect(container).toBeEmptyDOMElement()
    rerender(results({ ...run, resultReporting: 'offered' }))
    expect(screen.getByText('No warnings reported.')).toBeInTheDocument()
  })

  it('retains the preview across collapse and history refreshes with new output objects', async () => {
    const load = vi.fn(async () => 'Preview body')
    const { rerender } = render(results({ ...run, outputs: [output] }, { load }))
    const preview = await screen.findByText('Preview body')
    const trigger = screen.getByRole('button', { name: /Notes/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    rerender(results({ ...run, outputs: [{ ...output }] }, { load }))
    expect(screen.getByText('Preview body')).toBe(preview)
    expect(load).toHaveBeenCalledExactlyOnceWith('o1')
  })

  it('keeps the actual read failure and retries the same output', async () => {
    const load = vi
      .fn<AutomationRunOutputActions['load']>()
      .mockRejectedValueOnce(new Error('SSH host disconnected'))
      .mockResolvedValueOnce('Recovered preview')
    render(results({ ...run, outputs: [output] }, { load }))
    expect(await screen.findByText(/SSH host disconnected/)).toHaveTextContent(
      "Couldn't load preview."
    )
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Recovered preview')).toBeInTheDocument()
    expect(load.mock.calls).toEqual([['o1'], ['o1']])
  })

  it.each(['open', 'download'] as const)(
    'disables both output actions until %s settles',
    async (action) => {
      const pending = Promise.withResolvers<void>()
      const open = vi.fn(async () => {})
      const download = vi.fn(async () => {})
      const actions = { open, download }
      actions[action].mockReturnValueOnce(pending.promise)
      render(results({ ...run, outputs: [output] }, actions))
      await screen.findByText('Preview body')
      const openButton = screen.getByRole('button', { name: 'Save and open' })
      const downloadButton = screen.getByRole('button', { name: 'Download' })
      fireEvent.click(action === 'open' ? openButton : downloadButton)
      expect(openButton).toBeDisabled()
      expect(downloadButton).toBeDisabled()
      fireEvent.click(openButton)
      fireEvent.click(downloadButton)
      expect(actions[action]).toHaveBeenCalledExactlyOnceWith(output)
      expect(actions[action === 'open' ? 'download' : 'open']).not.toHaveBeenCalled()
      await act(async () => pending.resolve())
      expect(openButton).toBeEnabled()
      expect(downloadButton).toBeEnabled()
      fireEvent.click(action === 'open' ? downloadButton : openButton)
      await act(async () => {})
      expect(open).toHaveBeenCalledOnce()
      expect(download).toHaveBeenCalledOnce()
    }
  )

  it('renders Markdown media as links without mounting images or video', async () => {
    const image = 'https://example.com/image.png'
    const video = 'https://github.com/user-attachments/assets/clip.mp4'
    const { container } = render(
      results(
        { ...run, outputs: [output] },
        {
          load: async () =>
            `![External image](${image})\n\n<image src="${image}" />\n\n<img src="${image}" alt="Raw image" />\n\n${video}`
        }
      )
    )
    expect(await screen.findByRole('link', { name: 'External image' })).toHaveAttribute(
      'href',
      image
    )
    expect(screen.getByRole('link', { name: 'Raw image' })).toHaveAttribute('href', image)
    expect(screen.getByRole('link', { name: video })).toHaveAttribute('href', video)
    expect(container.querySelector('img, video, audio, iframe')).toBeNull()
  })

  it('strips HTML navigation links while keeping scripts sandboxed and resources blocked', async () => {
    render(
      results(
        { ...run, outputs: [{ ...output, format: 'html' }] },
        {
          load: async () =>
            '<a href="https://example.com" target="_blank">Link</a><svg><a href="/remote">SVG</a></svg><script>window.ran=true</script>'
        }
      )
    )
    const frame = await screen.findByTitle('Notes')
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin')
    expect(frame).toHaveAttribute('name', 'orca-automation-output-o1')
    const doc = new DOMParser().parseFromString(frame.getAttribute('srcdoc') ?? '', 'text/html')
    expect(doc.querySelectorAll('a[href], area[href], a[target]')).toHaveLength(0)
    expect(
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')
    ).toContain("default-src 'none'")
  })
})
