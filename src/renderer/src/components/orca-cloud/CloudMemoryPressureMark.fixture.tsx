import { Cloud } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { CloudMemoryPressureMark } from './CloudMemoryPressureMark'

type Pressure = 'high' | 'critical'

// MEMGUARD: a running cloud workspace's sidebar row while its VM is short of memory.
function seed(pressure: Pressure): void {
  const status: HostedWorkspaceStatus = {
    state: 'ready',
    metrics: null,
    memory: {
      pressure,
      guardKills: 0,
      lastGuardVictim: null,
      lastGuardKillAt: null,
      guarded: true
    },
    uptimeMs: 60_000,
    usage: { totalMs: 60_000, centsPerHour: 75, costCents: 1 },
    archive: null,
    checkedAt: Date.now()
  }
  seedCloudWorkspaceSnapshot({
    ids: new Set(['gudgeon']),
    idsLoaded: true,
    status: { gudgeon: { status, loading: false, error: null, fetchedAt: Date.now() } }
  })
}

function Row(): React.JSX.Element {
  return (
    <div className="flex w-[300px] items-center gap-1.5 rounded-md bg-accent/40 px-2 py-1.5 text-[13px]">
      <Cloud className="size-3 text-muted-foreground" aria-hidden />
      <span>gudgeon</span>
      <CloudMemoryPressureMark worktreeId="gudgeon" />
    </div>
  )
}

const markFixture = (pressure: Pressure) =>
  defineFixture({
    width: 380,
    render: () => {
      seed(pressure)
      return (
        <div className="h-[110px] p-3">
          <Row />
        </div>
      )
    },
    interact: async (frame: HTMLElement) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mark = frame.querySelector<HTMLElement>('[data-cloud-memory-pressure]')
      mark?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      mark?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 900))
    }
  })

/** Memory is low (under 15% available, or the kernel stalls on it): the quiet mark. */
export const sidebarRowMemoryHigh = markFixture('high')
/** Under 8%: Orca's guard may stop the largest process. Amber. */
export const sidebarRowMemoryCritical = markFixture('critical')
