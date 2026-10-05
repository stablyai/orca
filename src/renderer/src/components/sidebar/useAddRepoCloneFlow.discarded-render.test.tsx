// @vitest-environment happy-dom

import React, { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({})
  })
}))

import { useAddRepoCloneFlow } from './useAddRepoCloneFlow'
import type { AddRepoDialogStep } from './add-repo-dialog-types'

// A Suspense unwind discards the render without replaying it; StrictMode cannot show this.
const settledSteps = new Set<string>()
let releasePending: (() => void) | null = null

/** Suspends the first render of each unseen step so the sibling probe's render is discarded. */
function SuspendOnNewStep({ step }: { step: string }): null {
  if (!settledSteps.has(step)) {
    throw new Promise<void>((resolve) => {
      releasePending = () => {
        settledSteps.add(step)
        resolve()
      }
    })
  }
  return null
}

/** Shows the hook's clone destination for a step next to the suspender that discards the render. */
function CloneStepProbe({ step }: { step: AddRepoDialogStep }): React.JSX.Element {
  const { cloneDestination } = useAddRepoCloneFlow({
    step,
    activeRuntimeEnvironmentId: null,
    sshTargetId: null,
    workspaceDir: '/home/dev/orca/workspaces',
    fetchWorktrees: async () => undefined,
    onGitRepoReady: async () => undefined
  })
  return (
    <>
      <span data-testid="destination">{cloneDestination}</span>
      <SuspendOnNewStep step={step} />
    </>
  )
}

/** Wraps the probe in the Suspense boundary that a step change unwinds. */
function boundary(step: AddRepoDialogStep): React.JSX.Element {
  return (
    <Suspense fallback={<span data-testid="fallback">loading</span>}>
      <CloneStepProbe step={step} />
    </Suspense>
  )
}

beforeEach(() => {
  settledSteps.clear()
  settledSteps.add('add')
  releasePending = null
})

afterEach(cleanup)

describe('useAddRepoCloneFlow destination auto-fill', () => {
  it('seeds the default clone parent even when the seeding render is discarded', async () => {
    const { rerender } = render(boundary('add'))
    expect(screen.getByTestId('destination').textContent).toBe('')

    rerender(boundary('clone'))
    expect(screen.getByTestId('fallback')).toBeTruthy()

    await act(async () => {
      releasePending?.()
      await Promise.resolve()
    })

    expect(screen.getByTestId('destination').textContent).toBe('/home/dev/orca')
  })
})
