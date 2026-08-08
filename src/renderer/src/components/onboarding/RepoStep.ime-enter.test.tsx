// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { TooltipProvider } from '../ui/tooltip'
import { RepoStep } from './RepoStep'

function renderStep(onClone: () => void): HTMLInputElement {
  render(
    <TooltipProvider>
      <RepoStep
        cloneUrl="git@github.com:org/한글.git"
        onCloneUrlChange={() => {}}
        nestedScan={null}
        nestedSelectedPaths={new Set()}
        onNestedSelectedPathsChange={() => {}}
        onImportNested={() => {}}
        onCancelNested={() => {}}
        onStopNestedScan={() => {}}
        nestedScanInProgress={false}
        onOpenFolder={() => {}}
        onOpenServerFolder={() => {}}
        onClone={onClone}
        onOpenSshSettings={() => {}}
        serverPath=""
        onServerPathChange={() => {}}
        cloneDestination=""
        onCloneDestinationChange={() => {}}
        workspaceDir="/workspace"
        runtimeActive={false}
        busyLabel={null}
        error={null}
      />
    </TooltipProvider>
  )
  return screen.getByPlaceholderText('git@github.com:org/repo.git') as HTMLInputElement
}

afterEach(cleanup)

describe('RepoStep clone IME implicit submit', () => {
  it('does not clone a repository on the recorded Korean Enter redispatch', () => {
    const onClone = vi.fn()
    const input = renderStep(onClone)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onClone).not.toHaveBeenCalled()
  })

  it('clones a repository exactly once on an ordinary Enter', () => {
    const onClone = vi.fn()
    const input = renderStep(onClone)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onClone).toHaveBeenCalledOnce()
  })
})
