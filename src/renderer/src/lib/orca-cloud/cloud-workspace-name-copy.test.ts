// A nameless cloud workspace gets its own sentence, never "This workspace" mid-template.
import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  cloudWakeFailedTitle,
  cloudWorkspaceAnnouncement,
  cloudWorkspaceTitle,
  type CloudWorkspacePhaseAnnouncement
} from './cloud-workspace-name-copy'

const KINDS: CloudWorkspacePhaseAnnouncement[] = [
  'waking',
  'restarting',
  'unarchiving',
  'archived',
  'asleep'
]

describe('cloud workspace name copy', () => {
  it('names the workspace when it has a name', () => {
    expect(cloudWakeFailedTitle('fix-auth', translate)).toBe('Couldn’t wake fix-auth')
    expect(cloudWorkspaceTitle('fix-auth', translate)).toBe('fix-auth')
    for (const kind of KINDS) {
      expect(cloudWorkspaceAnnouncement(kind, 'fix-auth', translate)).toContain('fix-auth')
    }
  })

  it('without a name: plain sentences, and the title reads "Cloud workspace"', () => {
    for (const name of [null, undefined, '']) {
      expect(cloudWakeFailedTitle(name, translate)).toBe('Couldn’t wake this workspace')
      expect(cloudWorkspaceTitle(name, translate)).toBe('Cloud workspace')
      for (const kind of KINDS) {
        const line = cloudWorkspaceAnnouncement(kind, name, translate)
        // Never a capital "This workspace" after the first word.
        expect(line).not.toMatch(/\S This workspace/)
        expect(line.length).toBeGreaterThan(0)
      }
    }
    expect(cloudWorkspaceAnnouncement('waking', null, translate)).toBe('Waking this workspace.')
    expect(cloudWorkspaceAnnouncement('asleep', null, translate)).toBe('This workspace is asleep.')
  })
})
