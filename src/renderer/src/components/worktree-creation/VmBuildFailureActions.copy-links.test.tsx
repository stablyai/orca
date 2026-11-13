// @vitest-environment happy-dom
// COPY-LINK-RULE on the build sheet: "How to push to GitHub" is a split button whose chevron copies
// GitHub's guide; "Contact support" lives in the More menu, so a "Copy support link" item sits
// right below it.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { FailureActionRow, type VmBuildFailureActions } from './VmBuildFailureActions'
import type { VmBuildFailure } from './vm-build-failure'
import { ORCA_SUPPORT_URL, PUSH_TO_GITHUB_URL } from './vm-build-repo-actions'
import { translate } from '@/i18n/i18n'

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { ...window.api, ui: { writeClipboardText } } })
})
afterEach(cleanup)

const actions = (): VmBuildFailureActions => ({
  onFixWithAgent: vi.fn(),
  onRetry: vi.fn(),
  onEditRecipe: vi.fn(),
  onOpenAnyway: vi.fn(),
  onStartAgain: vi.fn(),
  onDismiss: vi.fn(),
  onSeePlans: vi.fn(),
  onOpenBilling: vi.fn(),
  onCreateLocally: vi.fn(),
  onSignIn: vi.fn(),
  onShowWorkspaces: vi.fn(),
  onContactSupport: vi.fn(),
  onConnectGitHub: vi.fn(),
  onPushToGitHub: vi.fn()
})

function row(failure: VmBuildFailure, handlers: VmBuildFailureActions) {
  return render(
    <TooltipProvider>
      <FailureActionRow
        failure={failure}
        cloud
        vmKept={false}
        canFixWithAgent={false}
        canManageBilling
        signingIn={false}
        connectingGitHub={false}
        actions={handlers}
        t={translate}
      />
    </TooltipProvider>
  )
}

describe('build sheet external links (COPY-LINK-RULE)', () => {
  it('"How to push to GitHub" opens as before, and its chevron copies the guide without opening', async () => {
    const handlers = actions()
    row({ kind: 'noGithubRemote' }, handlers)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'How to push to GitHub' }))
    expect(handlers.onPushToGitHub).toHaveBeenCalledOnce()
    expect(writeClipboardText).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'More link options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(PUSH_TO_GITHUB_URL))
    expect(handlers.onPushToGitHub).toHaveBeenCalledOnce()
  })

  it('"Copy support link" sits right below "Contact support" and copies without opening', async () => {
    const handlers = actions()
    row({ kind: 'snapshotMissing' }, handlers)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /More/ }))
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    expect(items).toEqual(['Contact support', 'Copy support link'])
    await user.click(screen.getByRole('menuitem', { name: 'Copy support link' }))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(ORCA_SUPPORT_URL))
    expect(handlers.onContactSupport).not.toHaveBeenCalled()
  })
})
