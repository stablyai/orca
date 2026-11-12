// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ClaudeUsagePane } from './ClaudeUsagePane'
import { CodexUsagePane } from './CodexUsagePane'
import { OpenCodeUsagePane } from './OpenCodeUsagePane'
import { MuseUsagePane } from './MuseUsagePane'
import type { AppState } from '../../store/types'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Setup replaces this placeholder before any usage component renders.
const fixture = vi.hoisted(() => ({ state: {} as AppState }))
vi.mock('../../store', () => ({
  useAppStore: (select: (state: AppState) => unknown) => select(fixture.state)
}))
const providers = [
  ['claude', 'Claude', ClaudeUsagePane],
  ['codex', 'Codex', CodexUsagePane],
  ['openCode', 'OpenCode', OpenCodeUsagePane],
  ['muse', 'Muse', MuseUsagePane]
] as const
function setup(kind: 'unknown' | 'disabled' | 'empty' | 'cached') {
  const values: Record<string, unknown> = { recordFeatureInteraction: vi.fn() }
  for (const [prefix, name] of providers) {
    Object.assign(values, {
      [`${prefix}UsageFailure`]: { terminal: false, read: false, refresh: true, setting: false },
      [`${prefix}UsageScanState`]:
        kind === 'unknown'
          ? null
          : {
              enabled: kind !== 'disabled',
              isScanning: false,
              lastScanCompletedAt: kind === 'empty' ? null : 1,
              lastScanError: kind === 'cached' ? 'source scan failed' : null,
              [`hasAny${name}Data`]: false
            },
      [`${prefix}UsageSummary`]: null,
      [`${prefix}UsageDaily`]: [],
      [`${prefix}UsageScope`]: 'orca',
      [`${prefix}UsageRange`]: '30d',
      [`observe${name}Usage`]: () => () => {},
      [`refresh${name}Usage`]: vi.fn(),
      [`enable${name}Usage`]: vi.fn(),
      [`set${name}UsageEnabled`]: vi.fn()
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the populated usage surface selectors are exercised.
  fixture.state = values as unknown as AppState
}
afterEach(cleanup)

it.each(providers)(
  '%s exposes failure and Refresh in unknown, disabled, empty and cached states',
  (_prefix, name, Pane) => {
    for (const kind of ['unknown', 'disabled', 'empty', 'cached'] as const) {
      setup(kind)
      const view = render(<Pane />)
      expect(screen.getByRole('alert').textContent).toBe(
        'The previous Refresh could not be completed. Try Refresh again.'
      )
      if (kind === 'cached') {
        expect(screen.getByText(/Updated/).textContent).toContain('source scan failed')
      }
      const retry = screen.getByRole('button', { name: /Refresh/ })
      expect(retry.hasAttribute('disabled')).toBe(false)
      fireEvent.click(retry)
      expect(fixture.state[`refresh${name}Usage`]).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(kind === 'unknown')
      view.unmount()
    }
  }
)
