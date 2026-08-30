// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPtyProcessInspectionWireResult } from '../../../../shared/pty-process-inspection-evidence'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'
import { enrichWorkspaceCleanupCandidates } from '@/store/slices/workspace-cleanup-candidate-enrichment'
import {
  WORKTREE_ID,
  makeCandidate,
  makeState
} from '@/store/slices/workspace-cleanup-slice-test-harness'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { queryWorkspaceCleanupCandidates } from './workspace-cleanup-query'
import { WorkspaceCleanupConfirmRemove } from './workspace-cleanup-confirm-remove'

/**
 * Rounds 1-3 each computed the unverifiable verdict correctly and each shipped a
 * consumer that still deleted. So every consumer of the blocker is checked here
 * on its own, through the reader the dialog really calls — never through
 * `tier`/`selectedByDefault`, which are @deprecated and read by nothing.
 */

vi.mock('./workspace-cleanup-candidate-list', () => ({
  WorkspaceCleanupCandidateList: <Row,>({
    rows,
    renderRow
  }: {
    rows: readonly Row[]
    renderRow: (row: Row, index: number) => ReactNode
  }) => <>{rows.map(renderRow)}</>
}))

vi.mock('@/components/ui/dialog', () => ({
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const TAB_ID = 'tab-1'
const PTY_ID = 'pty-1'
const SHELL = 'zsh'

/**
 * What `LocalPtyProvider.inspectProcess` really publishes when the foreground
 * scan is degraded: legacy `foregroundProcess` is the stable-cache shell name
 * and `hasChildProcesses` is false, so the answer is byte-identical to an idle
 * shell. Built through the real classifier so the fixture cannot drift from the
 * producer.
 */
function degradedLocalInspection() {
  return {
    ...buildPtyProcessInspectionWireResult(
      { verdict: 'unverifiable', reason: 'process table scan degraded' },
      {
        verdict: 'unverifiable',
        reason: 'pty title matches the shell while the foreground scan is degraded'
      }
    ),
    // The one deliberate override: the provider publishes its stable-cache
    // legacy value, which for a pane that never ran an agent is the shell name.
    // See local-pty-provider-inspect-process-evidence.test.ts, "keeps the
    // stable-cache legacy value but marks a degraded scan unverifiable".
    foregroundProcess: SHELL
  }
}

function installPtyApi(inspectProcess: () => Promise<unknown>) {
  vi.stubGlobal('window', {
    api: {
      pty: {
        inspectProcess: vi.fn(inspectProcess),
        hasChildProcesses: vi.fn(async () => false),
        getForegroundProcess: vi.fn(async () => null),
        confirmForegroundProcess: vi.fn(async () => null)
      }
    }
  })
}

async function enrichUnderDegradedProbe(): Promise<WorkspaceCleanupCandidate> {
  installPtyApi(async () => degradedLocalInspection())
  const [candidate] = await enrichWorkspaceCleanupCandidates(
    [makeCandidate()],
    makeState({
      tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, title: SHELL }] } as never,
      ptyIdsByTabId: { [TAB_ID]: [PTY_ID] }
    }),
    { applyDismissals: false }
  )
  return candidate!
}

async function enrichUnderObservedIdleProbe(): Promise<WorkspaceCleanupCandidate> {
  installPtyApi(async () =>
    buildPtyProcessInspectionWireResult(
      { verdict: 'observed', processName: SHELL },
      { verdict: 'exited' }
    )
  )
  const [candidate] = await enrichWorkspaceCleanupCandidates(
    [makeCandidate()],
    makeState({
      tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, title: SHELL }] } as never,
      ptyIdsByTabId: { [TAB_ID]: [PTY_ID] }
    }),
    { applyDismissals: false }
  )
  return candidate!
}

/** The list the select-all checkbox writes into `selectedIds`, verbatim. */
function selectAll(candidate: WorkspaceCleanupCandidate): string[] {
  const browse = createDefaultWorkspaceCleanupBrowseState()
  return queryWorkspaceCleanupCandidates([candidate], {
    filters: browse.filters,
    sort: browse.sort
  }).selectableIdentities
}

/**
 * What the Remove button acts on after select-all: the dialog maps `selectedIds`
 * back to candidates and drops any the preflight would refuse, then disables
 * itself when that list is empty.
 */
function removeTargetsAfterSelectAll(candidate: WorkspaceCleanupCandidate): string[] {
  const identity = getWorkspaceCleanupCandidateIdentity(candidate)
  return selectAll(candidate).filter(
    (selected) => selected === identity && canQueueWorkspaceCleanupCandidate(candidate)
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('consumer 1: the bulk select-all default', () => {
  it('leaves a degraded local probe out of select-all', async () => {
    const candidate = await enrichUnderDegradedProbe()

    expect(candidate.blockers).toContain('terminal-liveness-unknown')
    expect(selectAll(candidate)).toEqual([])
  })

  it('still offers an observed-idle workspace to select-all', async () => {
    const candidate = await enrichUnderObservedIdleProbe()

    expect(selectAll(candidate)).toEqual([getWorkspaceCleanupCandidateIdentity(candidate)])
  })
})

describe('consumer 2: the Remove button', () => {
  it('has nothing to remove after select-all', async () => {
    const candidate = await enrichUnderDegradedProbe()

    expect(removeTargetsAfterSelectAll(candidate)).toEqual([])
  })

  it('still removes an observed-idle workspace after select-all', async () => {
    const candidate = await enrichUnderObservedIdleProbe()

    expect(removeTargetsAfterSelectAll(candidate)).toEqual([
      getWorkspaceCleanupCandidateIdentity(candidate)
    ])
  })

  it('keeps the row deletable when the user picks it deliberately', async () => {
    const candidate = await enrichUnderDegradedProbe()

    // Withholding the bulk default must not make an unverifiable workspace a
    // dead end; the escape hatch is an explicit, per-row choice.
    expect(canQueueWorkspaceCleanupCandidate(candidate)).toBe(true)
  })
})

describe('consumer 3: the confirm screen status pill', () => {
  function renderConfirm(candidate: WorkspaceCleanupCandidate): string {
    act(() => {
      root.render(
        <WorkspaceCleanupConfirmRemove
          candidates={[candidate]}
          now={Date.now()}
          reviewInfoByWorktreeId={new Map()}
          progress={null}
          onBack={() => {}}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      )
    })
    return container.textContent ?? ''
  }

  it('names the unverifiable terminal on the screen that authorizes the delete', async () => {
    const candidate = await enrichUnderDegradedProbe()

    expect(renderConfirm(candidate)).toContain('Terminal liveness unknown')
  })

  it('says nothing about terminal liveness for an observed-idle workspace', async () => {
    const candidate = await enrichUnderObservedIdleProbe()

    expect(renderConfirm(candidate)).not.toContain('Terminal liveness unknown')
  })
})
