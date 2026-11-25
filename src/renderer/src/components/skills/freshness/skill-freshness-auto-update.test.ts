import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BundledSkillInstallResult,
  BundledSkillOpOutcome
} from '../../../../../shared/skills/bundled/bundled-skill-plan'

vi.mock('sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('@/hooks/skills/discovery/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))
vi.mock('@/runtime/skills/bundled/runtime-bundled-skills-client', () => ({
  autoUpdateBundledSkillsOnTarget: vi.fn()
}))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: vi.fn()
}))
vi.mock('./skill-backup-location', () => ({
  skillBackupDirectory: (home: string) => `${home}/.agents/.orca-skill-backups`,
  skillBackupHost: () => ({ kind: 'local' })
}))
vi.mock('./skill-update-run-store', () => ({
  getSkillUpdateRun: vi.fn(),
  runAutomaticSkillUpdate: vi.fn()
}))

const { reportPreservedEdits, reportUncertainOutcome } =
  await import('./skill-freshness-auto-update')
const { toast } = await import('sonner')

const SKILLS = '/home/u/.agents/skills'
const result = (...ops: BundledSkillOpOutcome[]): BundledSkillInstallResult => ({
  scope: 'global',
  skills: [{ name: 'orca', status: 'ran', ops }]
})
const warnings = () =>
  vi.mocked(toast.warning).mock.calls.map(([title, options]) => ({
    title,
    description: options?.description
  }))

afterEach(() => {
  vi.mocked(toast.warning).mockClear()
})

describe('automatic update result notices', () => {
  it('names a retired copy put back in place after its backup was refused', () => {
    const former = '/home/u/.gemini/skills/orca'
    reportPreservedEdits(
      result({
        path: `${SKILLS}/orca`,
        kind: 'keep',
        status: 'failed',
        error: 'EXDEV',
        currentConfirmed: true,
        backupRefusal: { path: former, source: 'in-place', onlyNotice: true }
      })
    )
    expect(warnings()).toEqual([
      {
        title: "Orca couldn't back up your edits to orca",
        description: `Your edits are still in ${former}. Copy them somewhere safe before updating again.`
      }
    ])
  })

  it('names a refused moved-aside copy once, even when it is also the stranded path', () => {
    const aside = `${SKILLS}/.orca.orca-old-1`
    reportPreservedEdits(
      result({
        path: `${SKILLS}/orca`,
        kind: 'update',
        status: 'failed',
        error: 'EXDEV',
        contentApplied: true,
        strandedPath: aside,
        backupRefusal: { path: aside, source: 'moved-aside' }
      })
    )
    expect(warnings()).toEqual([
      {
        title: "Orca couldn't back up your edits to orca",
        description: `Your edits are still in ${aside}. Copy them somewhere safe before updating again.`
      }
    ])
  })

  it('says it updated the skill only when the op published new content', () => {
    reportPreservedEdits(
      result(
        { path: `${SKILLS}/orca`, kind: 'keep', status: 'done', backupPath: '/b/1' },
        {
          path: '/home/u/.claude/skills/orca',
          kind: 'update',
          status: 'done',
          backupPath: '/b/2',
          backupPaths: ['/b/2', '/b/3']
        }
      )
    )
    expect(warnings().map(({ description }) => description)).toEqual([
      'Orca saved your edits to /b/1.',
      'Orca updated the skill and saved your edits to /b/2.',
      'Orca updated the skill and saved your edits to /b/3.'
    ])
  })

  it('says a lost reply may have left an edited copy in the skills folder', () => {
    reportUncertainOutcome({ kind: 'local' }, { homeDirectory: '/home/u' })
    expect(warnings()[0]?.description).toBe(
      "Orca may have updated skills on This machine but couldn't confirm the result. If you edited a skill during the update, your copy is in /home/u/.agents/.orca-skill-backups or still in the skills folder."
    )
  })
})
