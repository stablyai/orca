// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  CloudWorkspacesToolbar,
  INITIAL_CLOUD_WORKSPACE_FILTERS,
  type CloudWorkspacesFilters
} from './CloudWorkspacesToolbar'
import { readShowRoutineRuns, writeShowRoutineRuns } from './cloud-workspaces-home-prefs'
import type { CloudWorkspaceRoutineRuns } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

// The toolbar's trial banner and Routines entry read the preload bridge; neither is under test.
vi.mock('../new-workspace/run-on/OrcaCloudTrialUsedUpNotice', () => ({
  OrcaCloudTrialUsedUpBanner: () => null
}))
vi.mock('@/hooks/useOrcaCloudApiAvailability', () => ({ useOrcaCloudApiAvailable: () => false }))

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

describe('Routine runs preference', () => {
  it('is remembered per account', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v)
    } as unknown as Storage
    expect(readShowRoutineRuns('u1:org', storage)).toBe(false)
    writeShowRoutineRuns('u1:org', true, storage)
    expect(readShowRoutineRuns('u1:org', storage)).toBe(true)
    expect(readShowRoutineRuns('u2:org', storage)).toBe(false)
    writeShowRoutineRuns('u1:org', false, storage)
    expect(readShowRoutineRuns('u1:org', storage)).toBe(false)
    store.set('orca.cloudWorkspacesHome.showRoutineRuns', 'not json')
    expect(readShowRoutineRuns('u1:org', storage)).toBe(false)
  })
})
