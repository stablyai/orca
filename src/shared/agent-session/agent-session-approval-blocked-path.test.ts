import { describe, expect, it } from 'vitest'
import {
  approvalBlockedPathToShow,
  type ApprovalCardText
} from './agent-session-approval-blocked-path'

describe('approvalBlockedPathToShow', () => {
  it('hides a path the tool input already shows, including JSON-escaped Windows paths', () => {
    const blockedPath = 'C:\\qa\\demo\\notes.md'
    expect(
      approvalBlockedPathToShow({
        blockedPath,
        detail: JSON.stringify({ file_path: blockedPath }, null, 2)
      })
    ).toBeNull()
    expect(
      approvalBlockedPathToShow({ blockedPath: '/tmp/out.txt', detail: 'echo hi > /tmp/out.txt' })
    ).toBeNull()
  })

  it('checks only the text the card draws: a plan replaces the detail', () => {
    expect(
      approvalBlockedPathToShow({
        blockedPath: '/repo/notes.md',
        subject: { kind: 'plan', text: 'Read /repo/notes.md' },
        detail: 'unused'
      })
    ).toBeNull()
    expect(
      approvalBlockedPathToShow({
        blockedPath: '/repo/plan.md',
        subject: { kind: 'plan', text: '# Plan', filePath: '/repo/plan.md' },
        detail: 'unused'
      })
    ).toBeNull()
    expect(
      approvalBlockedPathToShow({
        blockedPath: '/outside/x',
        subject: { kind: 'plan', text: '# Plan' },
        detail: '/outside/x'
      })
    ).toBe('/outside/x')
  })

  it("checks the detail a newer Orca's subject falls back to", () => {
    const subject: ApprovalCardText['subject'] = JSON.parse('{"kind":"diff"}')
    expect(
      approvalBlockedPathToShow({ blockedPath: '/outside/x', subject, detail: 'edit /outside/x' })
    ).toBeNull()
    expect(approvalBlockedPathToShow({ blockedPath: '/outside/x', subject, detail: 'edit' })).toBe(
      '/outside/x'
    )
  })

  it('distinguishes whole paths from longer names across all occurrences', () => {
    expect(
      approvalBlockedPathToShow({ blockedPath: '/srv/data', detail: 'ls /srv/data-old /srv/data' })
    ).toBeNull()
    expect(
      approvalBlockedPathToShow({ blockedPath: '/srv/data', detail: 'ls /srv/data-old/x' })
    ).toBe('/srv/data')
    expect(
      approvalBlockedPathToShow({
        blockedPath: 'C:\\qa\\demo',
        detail: JSON.stringify({ file_path: 'C:\\qa\\demo2\\notes.md' }, null, 2)
      })
    ).toBe('C:\\qa\\demo')
  })

  it('hides a path the text names before a separator, quote or space', () => {
    expect(
      approvalBlockedPathToShow({ blockedPath: '/srv/data', detail: 'ls /srv/data/x' })
    ).toBeNull()
    expect(
      approvalBlockedPathToShow({ blockedPath: '/srv/data', detail: "cd '/srv/data' && ls" })
    ).toBeNull()
    expect(
      approvalBlockedPathToShow({
        blockedPath: 'C:\\qa\\demo',
        detail: JSON.stringify({ file_path: 'C:\\qa\\demo\\notes.md' }, null, 2)
      })
    ).toBeNull()
  })
})
