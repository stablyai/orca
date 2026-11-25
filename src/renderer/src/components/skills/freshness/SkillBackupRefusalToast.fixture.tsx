// Automatic-update toasts for a refused cross-drive backup, backups and a lost reply.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Toaster } from '../../ui/sonner'
import type {
  BundledSkillInstallResult,
  BundledSkillOpOutcome
} from '../../../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/skills/runtime/bundled-skill-target'
import { reportPreservedEdits, reportUncertainOutcome } from './skill-freshness-auto-update'

const SKILLS = '/Users/sam/.agents/skills'
const BACKUPS = '/Users/sam/.agents/.orca-skill-backups'
const ASIDE = `${SKILLS}/.electron.orca-old-7b1d44e0`

function result(ops: Record<string, BundledSkillOpOutcome>): BundledSkillInstallResult {
  return {
    scope: 'global',
    skills: Object.entries(ops).map(([name, op]) => ({ name, status: 'ran' as const, ops: [op] }))
  }
}

function Toasts({ show }: { show: () => void }): React.JSX.Element {
  useEffect(() => {
    show()
    return () => {
      toast.dismiss()
    }
  }, [show])
  return (
    <>
      {/* Sonner pins toasts to the viewport's corner; fill the viewport so the capture holds them. */}
      <div className="h-[900px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

const movedAside = result({
  electron: {
    path: `${SKILLS}/electron`,
    kind: 'update',
    status: 'failed',
    error: 'EXDEV',
    contentApplied: true,
    strandedPath: ASIDE,
    backupRefusal: { path: ASIDE, source: 'moved-aside' }
  }
})
const putBack = result({
  'orca-cli': {
    path: `${SKILLS}/orca-cli`,
    kind: 'keep',
    status: 'failed',
    error: 'EXDEV',
    currentConfirmed: true,
    backupRefusal: {
      path: '/Users/sam/.gemini/skills/orca-cli',
      source: 'in-place',
      onlyNotice: true
    }
  }
})
const backups = result({
  'orca-plan': {
    path: `${SKILLS}/orca-plan`,
    kind: 'keep',
    status: 'done',
    backupPath: `${BACKUPS}/orca-plan-2026-11-24T10-00-00-000Z-1`
  },
  orchestration: {
    path: `${SKILLS}/orchestration`,
    kind: 'update',
    status: 'done',
    backupPath: `${BACKUPS}/orchestration-2026-11-24T10-00-00-000Z-2`
  }
})

// Toasts mount and animate in after the first paint; capture once they have.
async function toastsMounted(): Promise<void> {
  const deadline = performance.now() + 3000
  while (!document.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const LOCAL: BundledSkillTarget = { kind: 'local' }
const REMOTE: BundledSkillTarget = { kind: 'ssh', targetId: 'build-box' }

export const refusedMovedAside = defineFixture({
  render: () => <Toasts show={() => reportPreservedEdits(movedAside)} />,
  width: 1280,
  interact: toastsMounted
})
export const refusedPutBack = defineFixture({
  render: () => <Toasts show={() => reportPreservedEdits(putBack)} />,
  width: 1280,
  interact: toastsMounted
})
export const backupOnlyAndUpdated = defineFixture({
  render: () => <Toasts show={() => reportPreservedEdits(backups)} />,
  width: 1280,
  interact: toastsMounted
})
export const uncertainLocal = defineFixture({
  render: () => (
    <Toasts show={() => reportUncertainOutcome(LOCAL, { homeDirectory: '/Users/sam' })} />
  ),
  width: 1280,
  interact: toastsMounted
})
export const uncertainRemote = defineFixture({
  render: () => (
    <Toasts show={() => reportUncertainOutcome(REMOTE, { homeDirectory: '/home/sam' })} />
  ),
  width: 1280,
  interact: toastsMounted
})
