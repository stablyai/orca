// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckJob } from '../../../../shared/github/check-types'
import { CheckJobLogTail } from './check-job-log-tail'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const copy = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  copy.mockClear()
  Object.assign(window, { api: { ui: { writeClipboardText: copy } } })
})
afterEach(cleanup)

type LogJob = Pick<PRCheckJob, 'status' | 'conclusion' | 'logState' | 'logTail'>
const neutral = 'No log excerpt is available.'
const pending = 'Log output is not available yet.'
const empty = 'No log output was returned.'
const limit = "Log excerpt wasn't requested. At most five failed-job excerpts are loaded per check."
const literal =
  'Error: synthetic diagnostic\n<script>literal</script>\r\n\u001b[31mexisting payload\u001b[0m'
const cases: { name: string; job: Partial<LogJob>; message?: string; hidden?: boolean }[] = [
  { name: 'available', job: { logState: 'available', logTail: literal } },
  { name: 'omitted legacy text', job: { logTail: literal } },
  { name: 'empty null', job: { logState: 'empty' }, message: empty },
  { name: 'empty string', job: { logState: 'empty', logTail: '' }, message: empty },
  { name: 'error null', job: { logState: 'error' } },
  { name: 'error string', job: { logState: 'error', logTail: '' } },
  { name: 'retained text plus error', job: { logState: 'error', logTail: literal } },
  { name: 'limit', job: { logState: 'not_requested' }, message: limit },
  { name: 'legacy null', job: {}, message: neutral },
  { name: 'available null', job: { logState: 'available' }, message: neutral },
  {
    name: 'available empty running',
    job: { logState: 'available', status: 'in_progress' },
    message: neutral
  },
  { name: 'running unknown', job: { status: 'in_progress', conclusion: null }, message: pending },
  {
    name: 'queued limit',
    job: { status: 'queued', conclusion: null, logState: 'not_requested' },
    message: pending
  },
  { name: 'running error', job: { status: 'running', conclusion: null, logState: 'error' } },
  {
    name: 'running empty',
    job: { status: 'running', conclusion: null, logState: 'empty' },
    message: empty
  },
  { name: 'manual approval', job: { conclusion: 'action_required' }, message: neutral },
  { name: 'startup failure', job: { conclusion: 'startup_failure' }, message: neutral },
  { name: 'cancelled', job: { conclusion: 'cancelled' }, message: neutral },
  { name: 'quiet legacy success', job: { conclusion: 'success' }, hidden: true },
  { name: 'quiet legacy skipped', job: { conclusion: 'skipped' }, hidden: true },
  { name: 'retained empty contradiction', job: { logState: 'empty', logTail: literal } },
  { name: 'retained limit contradiction', job: { logState: 'not_requested', logTail: literal } }
]

describe.each(['sidebar', 'details'] as const)('shared job log outcomes on %s', (surface) => {
  it.each(cases)(
    '$name preserves literal text and allowlisted outcome copy',
    async ({ job, message, hidden }) => {
      const payload: LogJob = { status: 'completed', conclusion: 'failure', logTail: null, ...job }
      const { container } = render(
        <TooltipProvider>
          <CheckJobLogTail job={payload} surface={surface} expanded={surface === 'details'} />
        </TooltipProvider>
      )
      if (hidden) {
        expect(container.textContent).toBe('')
        return
      }
      expect(screen.getByText('Log excerpt')).toBeTruthy()
      const error =
        surface === 'details'
          ? "Couldn't load logs. Use Refresh to retry."
          : "Couldn't load logs. Open View full details, then use Refresh to retry."
      if (payload.logState === 'error') {
        expect(screen.getByText(error).classList.contains('text-destructive')).toBe(true)
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      } else {
        expect(screen.queryByText(error)).toBeNull()
      }
      if (message) {
        expect(screen.getByText(message)).toBeTruthy()
      }
      if (payload.logTail) {
        expect(container.querySelector('pre')?.textContent).toBe(payload.logTail)
        expect(container.querySelector('script')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Copy log excerpt' }))
        await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(payload.logTail))
      } else {
        expect(container.querySelector('pre')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Copy log excerpt' })).toBeNull()
      }
      expect(container.textContent).not.toMatch(/expired|404|stderr/i)
    }
  )
})
