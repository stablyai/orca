import { describe, expect, it } from 'vitest'
import type {
  BundledSkillOp,
  BundledSkillPlan
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { bundledSkillSetupAttentionMessage } from './bundled-skill-setup-result-copy'

const leave = (path: string, reason: BundledSkillOp['reason']): BundledSkillOp => ({
  kind: 'leave',
  path,
  role: 'agent',
  agents: ['claude'],
  observed: { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'b'.repeat(64) },
  cleanup: [],
  reason,
  replaceable: false
})

describe('setup attention message', () => {
  it("names the real blocker, not another Orca build's kept copy", () => {
    const plan: BundledSkillPlan = {
      scope: 'global',
      homeDirectory: '/home/me',
      planDigest: 'p'.repeat(64),
      skills: [
        {
          name: 'orca-cli',
          digest: 'a'.repeat(64),
          ops: [
            leave('/home/me/.agents/skills/orca-cli', 'other-build'),
            leave('/home/me/.cursor/skills/orca-cli', 'unwritable')
          ]
        }
      ]
    }

    expect(bundledSkillSetupAttentionMessage(plan)).toBe(
      "Needs attention · Orca can't write to ~/.cursor/skills"
    )
  })
})
