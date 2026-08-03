import { describe, expect, it } from 'vitest'
import {
  formatWorkspacePortProcessTooltip,
  getWorkspacePortProcessLabel
} from './workspace-port-process-label'

describe('getWorkspacePortProcessLabel', () => {
  it('promotes the dev server over the process name', () => {
    expect(
      getWorkspacePortProcessLabel({
        devServer: { id: 'vite', label: 'Vite' },
        processName: 'node',
        pid: 4242
      })
    ).toEqual({ label: 'Vite', detail: 'node' })
  })

  it('keeps the process name when no dev server was recognized', () => {
    expect(getWorkspacePortProcessLabel({ processName: 'node', pid: 4242 })).toEqual({
      label: 'node'
    })
  })

  it('falls back to the pid, then to a placeholder', () => {
    expect(getWorkspacePortProcessLabel({ pid: 4242 })).toEqual({ label: 'PID 4242' })
    expect(getWorkspacePortProcessLabel({})).toEqual({ label: 'Unknown process' })
  })

  it('omits the detail when the process name only restates the dev server', () => {
    expect(
      getWorkspacePortProcessLabel({
        devServer: { id: 'hugo', label: 'Hugo' },
        processName: 'hugo'
      })
    ).toEqual({ label: 'Hugo' })
  })

  it('still labels a dev server whose process name is unknown', () => {
    expect(getWorkspacePortProcessLabel({ devServer: { id: 'vite', label: 'Vite' } })).toEqual({
      label: 'Vite'
    })
  })
})

describe('formatWorkspacePortProcessTooltip', () => {
  it('joins the dev server and the raw process name', () => {
    expect(formatWorkspacePortProcessTooltip({ label: 'Vite', detail: 'node' })).toBe('Vite — node')
  })

  it('returns the label alone when there is no detail', () => {
    expect(formatWorkspacePortProcessTooltip({ label: 'node' })).toBe('node')
  })
})
