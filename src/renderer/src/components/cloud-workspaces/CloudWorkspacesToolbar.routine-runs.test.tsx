// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  CloudWorkspacesToolbar,
  INITIAL_CLOUD_WORKSPACE_FILTERS,
  type CloudWorkspacesFilters
} from './CloudWorkspacesToolbar'
import { readHomeSwitches, writeHomeSwitches } from './cloud-workspaces-home-prefs'
import type { CloudWorkspaceRoutineRuns } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

// The toolbar's trial banner and Routines entry read the preload bridge; neither is under test.
vi.mock('../new-workspace/run-on/OrcaCloudTrialUsedUpNotice', () => ({
  OrcaCloudTrialUsedUpBanner: () => null
}))
vi.mock('@/hooks/useOrcaCloudApiAvailability', () => ({ useOrcaCloudApiAvailable: () => true }))
// The switch is behind the parked-Routines flag; flip it per test to cover both states.
const flag = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../shared/cloud-api/cloud-routines-ui', () => ({
  get CLOUD_ROUTINES_UI_ENABLED() {
    return flag.on
  }
}))

afterEach(cleanup)

function toolbar(
  routineRuns: CloudWorkspaceRoutineRuns | undefined,
  filters: Partial<CloudWorkspacesFilters> = {},
  onFiltersChange = vi.fn()
) {
  render(
    <TooltipProvider>
      <CloudWorkspacesToolbar
        filters={{ ...INITIAL_CLOUD_WORKSPACE_FILTERS, ...filters }}
        onFiltersChange={onFiltersChange}
        hasOrg
        owners={[]}
        repos={[]}
        directory={new Map()}
        selfId="u1"
        meta={null}
        metaStale={false}
        reading={false}
        onRefresh={vi.fn()}
        routineRuns={routineRuns}
      />
    </TooltipProvider>
  )
  return onFiltersChange
}

const runs = (over: Partial<CloudWorkspaceRoutineRuns> = {}): CloudWorkspaceRoutineRuns => ({
  routines: 1,
  hidden: 0,
  hiddenRunning: 0,
  hiddenComputeMs: 0,
  ...over
})

describe('Home toolbar while Routines are parked', () => {
  it('offers neither the Routines entry nor the Routine runs switch', () => {
    flag.on = false
    try {
      toolbar(runs({ hidden: 2, hiddenRunning: 1 }), { routines: true })
      expect(screen.queryByLabelText('Show routine runs')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Routines' })).toBeNull()
    } finally {
      flag.on = true
    }
  })
})

describe('Home toolbar: Routine runs switch', () => {
  it('is not offered to a team with no routines (or an older control plane)', () => {
    toolbar(runs({ routines: 0 }))
    expect(screen.queryByLabelText('Show routine runs')).toBeNull()
    cleanup()
    toolbar(undefined)
    expect(screen.queryByLabelText('Show routine runs')).toBeNull()
  })

  it('is off by default and counts the running runs it hides', () => {
    const onChange = toolbar(runs({ hidden: 3, hiddenRunning: 2 }))
    const toggle = screen.getByLabelText('Show routine runs')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Routine runs · 2')).toBeTruthy()
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith({ routines: true })
  })

  it('drops the count once the runs are listed', () => {
    toolbar(runs({ hidden: 0 }), { routines: true })
    expect(screen.getByLabelText('Show routine runs').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Routine runs')).toBeTruthy()
  })
})

describe('Home switch preferences', () => {
  it('remembers Running, Archived and Routine runs per account', () => {
    const store = new Map<string, string>()
    const storage: Storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size
      }
    }
    const off = { running: false, archived: false, routines: false }
    expect(readHomeSwitches('u1:org', storage)).toEqual(off)
    writeHomeSwitches('u1:org', { routines: true }, storage)
    writeHomeSwitches('u1:org', { running: true }, storage)
    expect(readHomeSwitches('u1:org', storage)).toEqual({
      running: true,
      archived: false,
      routines: true
    })
    expect(readHomeSwitches('u2:org', storage)).toEqual(off)
    writeHomeSwitches('u1:org', { running: false, routines: false }, storage)
    expect(readHomeSwitches('u1:org', storage)).toEqual(off)
    store.set('orca.cloudWorkspacesHome.switches', 'not json')
    expect(readHomeSwitches('u1:org', storage)).toEqual(off)
  })
})
