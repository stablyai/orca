import { describe, expect, it } from 'vitest'
import {
  approvalBlockedPathToShow,
  type ApprovalCardText
} from './agent-session-approval-blocked-path'

describe('approvalBlockedPathToShow', () => {
  it('shows a path the request does not name', () => {
    expect(
      approvalBlockedPathToShow({
        blockedPath: 'C:\\qa\\demo\\.git\\config',
        detail: 'git push origin main'
      })
    ).toBe('C:\\qa\\demo\\.git\\config')
  })

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

  it('hides a path the description or reason already names', () => {
    expect(
      approvalBlockedPathToShow({ blockedPath: '/etc/hosts', description: 'Read /etc/hosts' })
    ).toBeNull()
    expect(
      approvalBlockedPathToShow({
        blockedPath: '/srv/data',
        decisionReason: '/srv/data is outside the allowed working directories'
      })
    ).toBeNull()
  })

  it('checks only the text the card draws: a plan replaces the detail', () => {
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

  it('shows a resolved path when the request names it relatively', () => {
    expect(
      approvalBlockedPathToShow({ blockedPath: '/home/me/secret.txt', detail: 'cat ../secret.txt' })
    ).toBe('/home/me/secret.txt')
  })

  it('shows a path the text names only as the start of a longer name', () => {
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

  it('shows nothing without a blocked path', () => {
    expect(approvalBlockedPathToShow({ detail: 'git push' })).toBeNull()
    expect(approvalBlockedPathToShow({ blockedPath: '', detail: 'git push' })).toBeNull()
  })
})
