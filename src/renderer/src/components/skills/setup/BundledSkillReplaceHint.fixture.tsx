import { Download } from 'lucide-react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BundledSkillPlan } from '../../../../../shared/skills/bundled/bundled-skill-plan'
import { Button } from '@/components/ui/button'
import { BrowserAction } from '../../feature-wall/setup/browser/FeatureWallBrowserAction'
import { BundledSkillInstallStatus } from './BundledSkillInstallStatus'
import { BundledSkillReplaceHint } from './BundledSkillReplaceHint'
import { bundledSkillSetupAttentionMessage } from './bundled-skill-setup-result-copy'

const HOME = '/home/dev'

function seededPlan(folder: string, replaceable: boolean): BundledSkillPlan {
  return {
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
            path: `${HOME}/.codex/skills/${folder}`,
            role: 'agent',
            agents: ['codex'],
            observed: {
              kind: 'folder',
              entries: ['SKILL.md:file', 'agents:directory'],
              skillDigest: 'c'.repeat(64)
            },
            cleanup: [],
            reason: 'edited',
            replaceable
          }
        ]
      }
    ]
  }
}

async function openReplaceTooltip(frame: HTMLElement): Promise<void> {
  const deadline = performance.now() + 10_000
  const trigger = await new Promise<Element>((resolve, reject) => {
    const find = (): void => {
      const element = frame.querySelector('[data-slot="tooltip-trigger"]')
      if (element) {
        resolve(element)
      } else if (performance.now() >= deadline) {
        reject(new Error('Replace tooltip trigger did not render'))
      } else {
        requestAnimationFrame(find)
      }
    }
    find()
  })
  trigger.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
  await new Promise((resolve) => setTimeout(resolve, 900))
}

/** Settings' Replace button with its hint open. */
export const replaceButton = defineFixture({
  width: 420,
  render: () => (
    <div className="flex h-24 items-end p-3">
      <BundledSkillReplaceHint replacing>
        <Button type="button" variant="outline" size="sm">
          <Download className="size-3.5" />
          Replace with Orca’s
        </Button>
      </BundledSkillReplaceHint>
    </div>
  ),
  interact: openReplaceTooltip
})

export const featureWallReplace = defineFixture({
  width: 420,
  setup: () => {
    const { bundledPlan } = window.api.skills
    window.api.skills.bundledPlan = async () => {
      window.api.skills.bundledPlan = bundledPlan
      return seededPlan('orca-cli', true)
    }
  },
  render: () => (
    <div className="flex h-24 items-end p-3">
      <BrowserAction done />
    </div>
  ),
  interact: openReplaceTooltip
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
          message: bundledSkillSetupAttentionMessage(seededPlan('orca', false))
        }}
      />
    </div>
  )
})
