// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { TooltipProvider } from '../ui/tooltip'
import { RepoStep } from './RepoStep'

function renderStep(onOpenServerFolder: (kind: 'git' | 'folder') => void): HTMLInputElement {
  render(
    <TooltipProvider>
      <RepoStep
        cloneUrl=""
        onCloneUrlChange={() => {}}
        nestedScan={null}
        nestedSelectedPaths={new Set()}
        onNestedSelectedPathsChange={() => {}}
        onImportNested={() => {}}
        onCancelNested={() => {}}
        onStopNestedScan={() => {}}
        nestedScanInProgress={false}
        onOpenFolder={() => {}}
        onOpenServerFolder={onOpenServerFolder}
        onClone={() => {}}
        onOpenSshSettings={() => {}}
        serverPath="/workspace/한글"
        onServerPathChange={() => {}}
        cloneDestination=""
        onCloneDestinationChange={() => {}}
        workspaceDir="/workspace"
        runtimeActive
        busyLabel={null}
        error={null}
      />
    </TooltipProvider>
  )
  return screen.getByPlaceholderText('/home/user/project') as HTMLInputElement
}

afterEach(cleanup)

describe('RepoStep existing-project IME implicit submit', () => {
  it('does not import a project on the recorded Korean Enter redispatch', () => {
    const onOpenServerFolder = vi.fn()
    const input = renderStep(onOpenServerFolder)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onOpenServerFolder).not.toHaveBeenCalled()
  })

  it('imports a project exactly once on an ordinary Enter', () => {
    const onOpenServerFolder = vi.fn()
    const input = renderStep(onOpenServerFolder)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onOpenServerFolder).toHaveBeenCalledOnce()
    expect(onOpenServerFolder).toHaveBeenCalledWith('git')
  })
})
