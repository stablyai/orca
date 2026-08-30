// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertPaperclipSubmitAdmission } from './paperclip-submit-admission'

const getLaunchAdmission = vi.fn()
const paperclipScope = {
  paperclipIssueId: 'issue-1',
  paperclipConnectionId: 'connection-1',
  paperclipCompanyId: 'company-1',
  paperclipProjectId: 'project-1'
}

beforeEach(() => {
  getLaunchAdmission.mockReset()
  Object.assign(window, { api: { paperclip: { getLaunchAdmission } } })
})

describe('Paperclip submit admission', () => {
  it('does nothing for non-Paperclip work items', async () => {
    await assertPaperclipSubmitAdmission({
      provider: 'jira',
      type: 'issue',
      number: 1,
      title: 'Jira',
      url: 'https://jira.example/1'
    })
    expect(getLaunchAdmission).not.toHaveBeenCalled()
  })

  it('rejects Paperclip linkage before admission when the target runtime is not local', async () => {
    await expect(
      assertPaperclipSubmitAdmission(
        {
          provider: 'paperclip',
          type: 'issue',
          number: 0,
          title: 'Paperclip',
          url: 'http://127.0.0.1:3101/issues/1',
          ...paperclipScope
        },
        false
      )
    ).rejects.toThrow('available only on the local Orca runtime')
    expect(getLaunchAdmission).not.toHaveBeenCalled()
  })

  it('performs a fresh read and permits a clean Paperclip issue', async () => {
    getLaunchAdmission.mockResolvedValue({ allowed: true, requiresNonExclusiveConfirmation: true })
    await assertPaperclipSubmitAdmission({
      provider: 'paperclip',
      type: 'issue',
      number: 0,
      title: 'Paperclip',
      url: 'http://127.0.0.1:3101/issues/1',
      ...paperclipScope
    })
    expect(getLaunchAdmission).toHaveBeenCalledWith({
      issueId: 'issue-1',
      connectionId: 'connection-1',
      companyId: 'company-1',
      projectId: 'project-1'
    })
  })

  it.each(['active_run', 'claim_markers', 'unknown_run_state'] as const)(
    'fails closed for %s',
    async (reason) => {
      getLaunchAdmission.mockResolvedValue({ allowed: false, reason })
      await expect(
        assertPaperclipSubmitAdmission({
          provider: 'paperclip',
          type: 'issue',
          number: 0,
          title: 'Paperclip',
          url: 'http://127.0.0.1:3101/issues/1',
          ...paperclipScope
        })
      ).rejects.toThrow(/stopped/)
    }
  )
})
