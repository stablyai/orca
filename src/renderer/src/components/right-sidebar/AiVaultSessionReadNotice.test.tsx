// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { aiVaultSessionReadNotices } from './ai-vault-scan-issue-state'
import {
  AiVaultSessionReadNoticeProvider,
  SessionReadNotice,
  SessionReadNoticeIndicator
} from './AiVaultSessionReadNotice'

afterEach(cleanup)

const session: AiVaultSession = {
  id: 'local:pi:big',
  executionHostId: 'local',
  agent: 'pi',
  sessionId: 'big',
  title: 'Big session',
  cwd: '/repos/orca',
  branch: null,
  model: null,
  filePath: '/sessions/big.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-05-01T10:00:00.000Z',
  messageCount: 3,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'pi --resume big',
  subagent: null
}

function scan(messages: readonly string[]): AiVaultListResult {
  return {
    sessions: [session],
    issues: messages.map((message) => ({
      executionHostId: 'local' as const,
      agent: 'pi' as const,
      kind: 'notice' as const,
      path: session.filePath,
      message
    })),
    scannedAt: '2026-05-01T10:00:00.000Z'
  }
}

function renderWithNotices(result: AiVaultListResult): void {
  render(
    <TooltipProvider>
      <AiVaultSessionReadNoticeProvider notices={aiVaultSessionReadNotices(result)}>
        <SessionReadNoticeIndicator session={session} />
        <SessionReadNotice session={session} />
      </AiVaultSessionReadNoticeProvider>
    </TooltipProvider>
  )
}

// Why: the panel-wide banner is gone, so if the collapsed row says nothing the
// warning is only reachable by expanding a row the user has no reason to expand.
it('marks a partly read transcript on the collapsed row and spells it out expanded', () => {
  renderWithNotices(scan(['Skipped 1 oversized transcript record over the 10.0 MiB limit.']))

  expect(screen.getByLabelText('Partially read')).toBeTruthy()
  expect(screen.getByText('Partially read')).toBeTruthy()
  expect(
    screen.getByText('Skipped 1 oversized transcript record over the 10.0 MiB limit.')
  ).toBeTruthy()
})

// Why: the marker is the only thing naming the session, so a keyboard user has
// to be able to reach the tooltip that explains it.
it('exposes the collapsed marker to assistive tech and to the keyboard', () => {
  renderWithNotices(scan(['Skipped 1 oversized transcript record over the 10.0 MiB limit.']))

  const marker = screen.getByLabelText('Partially read')
  expect(marker.getAttribute('role')).toBe('img')
  expect(marker.getAttribute('tabindex')).toBe('0')
})

it('keeps two notices about one file as two sentences, not one run-on', () => {
  renderWithNotices(scan(['Skipped 1 oversized record.', 'Skipped 2 unreadable records.']))

  expect(screen.getByText('Skipped 1 oversized record.')).toBeTruthy()
  expect(screen.getByText('Skipped 2 unreadable records.')).toBeTruthy()
})

it('renders nothing for a session the scan had no note about', () => {
  renderWithNotices(scan([]))

  expect(screen.queryByLabelText('Partially read')).toBeNull()
  expect(screen.queryByText('Partially read')).toBeNull()
})
