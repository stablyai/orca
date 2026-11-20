// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import type { WorkspaceCleanupRun } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { WorkspaceCleanupActivityList } from './workspace-cleanup-activity-list'

const run: WorkspaceCleanupRun = {
  id: 'run-1',
  trigger: 'run-now',
  startedAt: Date.UTC(2026, 2, 5, 12),
  finishedAt: Date.UTC(2026, 2, 5, 12, 1),
  counts: { removed: 0, archived: 0, kept: 0, failed: 0 },
  freedBytes: 0,
  rows: []
}

afterEach(async () => {
  cleanup()
  await setRendererUiLanguage('en')
})

it('reformats the run date when the UI language changes', async () => {
  await setRendererUiLanguage('ja')
  render(
    <TranslationScopeProvider>
      <WorkspaceCleanupActivityList runs={[run]} />
    </TranslationScopeProvider>
  )
  expect(screen.getByText(/^3月5日/)).toBeTruthy()

  await act(() => setRendererUiLanguage('en'))
  expect(screen.getByText(/^Mar 5\b/)).toBeTruthy()
})
