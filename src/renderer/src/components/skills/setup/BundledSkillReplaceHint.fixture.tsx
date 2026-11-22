import { Download } from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BundledSkillPlan } from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { Button } from '@/components/ui/button'
import { BundledSkillInstallStatus } from './BundledSkillInstallStatus'
import { BundledSkillReplaceHint } from './BundledSkillReplaceHint'
import { bundledSkillSetupAttentionMessage } from './bundled-skill-setup-result-copy'

// Seeded data only: a made-up home with a copy under a former skill name.
const HOME = '/home/dev'
const formerNamePlan: BundledSkillPlan = {
  scope: 'global',
  homeDirectory: HOME,
  planDigest: 'b'.repeat(64),
  skills: [
    {
      name: 'orca-cli',
      digest: 'a'.repeat(64),
      ops: [
        {
          kind: 'leave',
          path: `${HOME}/.codex/skills/orca`,
          role: 'agent',
          agents: ['codex'],
          observed: {
            kind: 'folder',
            entries: ['SKILL.md:file', 'agents:directory'],
            skillDigest: 'c'.repeat(64)
          },
          cleanup: [],
          reason: 'edited',
          replaceable: false
        }
      ]
    }
  ]
}

/** Settings' Replace button with its hint open. */
export const replaceButton = defineFixture({
  width: 420,
  render: () => (
    <div className="flex h-24 items-end p-3">
      <BundledSkillReplaceHint replacing>
        <Button type="button" variant="outline" size="sm" data-fixture-trigger>
          <Download className="size-3.5" />
          Replace with Orca’s
        </Button>
      </BundledSkillReplaceHint>
    </div>
  ),
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLElement>('[data-fixture-trigger]')
    trigger?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
})

/** Settings' line for a copy Orca won't replace (a former skill name). */
export const attentionLine = defineFixture({
  width: 420,
  render: () => (
    <div className="p-3">
      <BundledSkillInstallStatus
        install={{ state: { kind: 'idle' }, retry: () => undefined }}
        attention={{
          retry: () => undefined,
          message: bundledSkillSetupAttentionMessage(formerNamePlan)
        }}
      />
    </div>
  )
})
