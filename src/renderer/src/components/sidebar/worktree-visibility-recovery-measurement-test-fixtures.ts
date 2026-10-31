import { mocks } from './worktree-visibility-dialog-test-fixtures'
import { vi } from 'vitest'
import type { DetectedWorktree } from '../../../../shared/worktree/types'

export async function measureRecovery() {
  const counts = {
    preparations: 0,
    requestReads: 0,
    memberReads: 0,
    scanProductReads: 0,
    partitionRows: 0,
    hiddenCalls: 0,
    hiddenVisits: 0,
    visibleCalls: 0,
    visibleVisits: 0,
    sourceRenders: 0,
    sourcePathReads: 0,
    listRenders: 0,
    nameReads: 0,
    nameBytes: 0,
    pathReads: 0,
    pathBytes: 0,
    listLowercaseCalls: 0,
    listLowercaseBytes: 0
  }
  let phase = ''
  const targets = await import('./worktree-visibility-host-target')
  const originalResolve = targets.resolveWorktreeVisibilityTargets
  const resolveSpy = vi
    .spyOn(targets, 'resolveWorktreeVisibilityTargets')
    .mockImplementation((...args) => {
      counts.preparations++
      const previous = phase
      phase = 'prepare'
      try {
        const result = originalResolve(...args)
        for (const entry of result.entries) {
          const repo = entry.repo
          Object.defineProperty(entry, 'repo', {
            get() {
              counts.memberReads++
              return repo
            }
          })
        }
        for (const target of result.scanTargets) {
          const scopes = target.scopes
          Object.defineProperty(target, 'scopes', {
            get() {
              counts.scanProductReads++
              return scopes
            }
          })
        }
        return result
      } finally {
        phase = previous
      }
    })
  const inbox = await import('../../../../shared/external-worktree-inbox')
  const originalHidden = inbox.getHiddenImportableExternalWorktrees
  const hiddenSpy = vi
    .spyOn(inbox, 'getHiddenImportableExternalWorktrees')
    .mockImplementation((...args) => {
      counts.hiddenCalls++
      const previous = phase
      phase = 'hidden'
      try {
        return originalHidden(...args)
      } finally {
        phase = previous
      }
    })
  const originalVisible = inbox.getVisibleNonOrcaWorktrees
  const visibleSpy = vi.spyOn(inbox, 'getVisibleNonOrcaWorktrees').mockImplementation((...args) => {
    counts.visibleCalls++
    const previous = phase
    phase = 'visible'
    try {
      return originalVisible(...args)
    } finally {
      phase = previous
    }
  })
  const source = await import('./WorktreeVisibilitySourceList')
  const originalSource = source.default
  const sourceSpy = vi.spyOn(source, 'default').mockImplementation((props) => {
    counts.sourceRenders++
    const previous = phase
    phase = 'source'
    try {
      return originalSource(props)
    } finally {
      phase = previous
    }
  })
  const list = await import('./HiddenWorktreeRecoveryList')
  const originalList = list.default
  const listSpy = vi.spyOn(list, 'default').mockImplementation((props) => {
    counts.listRenders++
    const previous = phase
    phase = 'list'
    try {
      return originalList(props)
    } finally {
      phase = previous
    }
  })
  const lowercase = String.prototype.toLowerCase
  const lowercaseSpy = vi.spyOn(String.prototype, 'toLowerCase').mockImplementation(function (
    this: string
  ) {
    if (phase === 'list') {
      counts.listLowercaseCalls++
      counts.listLowercaseBytes += this.length
    }
    return lowercase.call(this)
  })
  return {
    counts,
    snapshot: () => ({ ...counts, scans: mocks.state.fetchWorktrees.mock.calls.length }),
    measureRequests(targets: { repoId: string; hostId: string }[]) {
      for (const target of targets) {
        const repoId = target.repoId
        Object.defineProperty(target, 'repoId', {
          get() {
            counts.requestReads++
            return repoId
          }
        })
      }
    },
    row(row: DetectedWorktree): DetectedWorktree {
      return {
        ...row,
        get runtimeOwnerEnvironmentId() {
          if (phase === 'prepare') {
            counts.partitionRows++
          }
          return row.runtimeOwnerEnvironmentId
        },
        get visible() {
          if (phase === 'hidden') {
            counts.hiddenVisits++
          } else if (phase === 'visible') {
            counts.visibleVisits++
          }
          return row.visible
        },
        get displayName() {
          counts.nameReads++
          counts.nameBytes += row.displayName.length
          return row.displayName
        },
        get path() {
          counts.pathReads++
          counts.pathBytes += row.path.length
          if (phase === 'source') {
            counts.sourcePathReads++
          }
          return row.path
        }
      }
    },
    restore() {
      lowercaseSpy.mockRestore()
      listSpy.mockRestore()
      sourceSpy.mockRestore()
      visibleSpy.mockRestore()
      hiddenSpy.mockRestore()
      resolveSpy.mockRestore()
    }
  }
}
