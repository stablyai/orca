import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createAutomationRunOutputActions } from './automation-run-output-actions'
import { readAutomationRunOutputForTarget } from './automation-host-client'
import type { AutomationRunOutput } from '../../../../shared/automation-run-result-types'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('./automation-host-client', () => ({ readAutomationRunOutputForTarget: vi.fn() }))

const output: AutomationRunOutput = {
  id: 'o1',
  title: 'Report',
  format: 'html',
  bytes: 7,
  attachedAt: 1
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('automation output open', () => {
  it.each([false, true])('reports OS launch failure=%s with the saved path', async (failed) => {
    const openFilePath = vi.fn().mockResolvedValue(!failed)
    vi.stubGlobal('window', {
      api: {
        fs: {
          saveDownloadedFile: vi
            .fn()
            .mockResolvedValue({ canceled: false, destinationPath: '/downloads/report.html' })
        },
        shell: { openFilePath }
      }
    })
    vi.mocked(readAutomationRunOutputForTarget).mockResolvedValue('<h1>Report</h1>')
    await createAutomationRunOutputActions(
      { kind: 'environment', environmentId: 'remote' },
      'r1'
    ).open(output)
    await vi.waitFor(() =>
      expect(openFilePath).toHaveBeenCalledWith('/downloads/report.html', 'local')
    )
    if (failed) {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't open the saved file at '/downloads/report.html'."
      )
    } else {
      expect(toast.error).not.toHaveBeenCalled()
    }
  })
})
