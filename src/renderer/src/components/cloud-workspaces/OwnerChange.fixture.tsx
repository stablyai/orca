// OWNER-TRANSFER: everything a person sees when a cloud workspace changes owner.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import { Toaster } from '@/components/ui/sonner'
import { CloudToastCard, type CloudToastView } from '@/components/orca-cloud/cloud-toast-stack'
import { OwnerChangedDetails } from '@/components/sidebar/workspace-card/details/WorktreeCardOwnerChangedDetails'
import type {
  OwnerChangeNotice,
  PreviousOwner
} from '../../../../shared/cloud-workspaces/owner-change-wire'
import { CloudWorkspaceConfirmDialog } from './CloudWorkspaceConfirmDialog'
import { OwnerChangedChip } from './CloudWorkspaceOwnerChangedChip'
import { DIRECTORY, SELF_ID, workspace } from './cloud-workspaces.test-fixture'
import {
  newOwnerNotice,
  ownerChangeRefusal,
  previousOwnerNotice,
  previousOwnerNoticeAction,
  previousOwnerToast
} from './owner-change-copy'

const noop = (): void => {}
const MINE = workspace({ title: 'Checkout retries' })
const THEIRS = workspace({ title: 'Checkout retries', ownerUserId: 'user_grace' })

/** In the workspace's top bar, beside the W-number: says why, on hover or focus. */
export const chipWithTooltip = defineFixture({
  width: 420,
  render: () => (
    <div className="flex h-32 items-start p-2">
      <OwnerChangedChip />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('[data-cloud-owner-changed]')?.focus()
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})

/** The same sentence in the sidebar's hover card for that workspace. */
export const sidebarHoverCardLine = defineFixture({
  width: 320,
  render: () => (
    <div className="rounded-lg border border-border bg-popover p-3">
      <OwnerChangedDetails />
    </div>
  )
})

/** The owner giving their own workspace away: what it does, then what they lose. */
export const confirmAsOwner = defineFixture({
  width: 640,
  render: () => (
    <div className="h-[420px]">
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'owner', workspace: MINE, ownerUserId: 'user_grace' }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin={false}
        onCancel={noop}
        onConfirm={noop}
      />
    </div>
  )
})

/** A team admin handing over a teammate's workspace: the same list, naming the owner. */
export const confirmAsAdmin = defineFixture({
  width: 640,
  render: () => (
    <div className="h-[420px]">
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'owner', workspace: THEIRS, ownerUserId: 'user_linus' }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        onCancel={noop}
        onConfirm={noop}
      />
    </div>
  )
})

/** While it runs: the workspace goes to sleep first, so the dialog stays open. */
export const confirmChanging = defineFixture({
  width: 640,
  render: () => (
    <div className="h-[420px]">
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'owner', workspace: THEIRS, ownerUserId: 'user_linus' }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        busy
        onCancel={noop}
        onConfirm={noop}
      />
    </div>
  )
})

/** A refusal, in place: nothing changed and the person can try again. */
export const confirmRefused = defineFixture({
  width: 640,
  render: () => (
    <div className="h-[460px]">
      <CloudWorkspaceConfirmDialog
        pending={{ kind: 'owner', workspace: THEIRS, ownerUserId: 'user_linus' }}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        error={ownerChangeRefusal('conflict', 'sandbox_not_stopped', 'Linus Park', translate)}
        onCancel={noop}
        onConfirm={noop}
      />
    </div>
  )
})

function AdminToast({
  previous,
  name
}: {
  previous: PreviousOwner
  name: string | null
}): React.JSX.Element {
  useEffect(() => {
    // After the Toaster has mounted: a toast raised before it subscribes is not shown.
    const timer = window.setTimeout(() => {
      toast.success(translate('auto.components.cloudWorkspaces.ownerChanged', 'Owner changed'), {
        id: 'owner-change-fixture',
        description: previousOwnerToast(previous, SELF_ID, name, translate) ?? undefined,
        duration: Number.POSITIVE_INFINITY
      })
    }, 100)
    return () => {
      window.clearTimeout(timer)
      toast.dismiss('owner-change-fixture')
    }
  }, [previous, name])
  return (
    <>
      <div className="h-[900px]" />
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 700))
}

/** For whoever made the change: the previous owner is still in the team. */
export const adminToastStillOnTeam = defineFixture({
  width: 1280,
  render: () => (
    <AdminToast
      previous={{ userId: 'user_grace', notified: true, inApp: true, emailed: false }}
      name="Grace Hopper"
    />
  ),
  interact: settle
})

/** The previous owner has left: Orca cannot tell them, so the admin is asked to. */
export const adminToastLeftTeam = defineFixture({
  width: 1280,
  render: () => (
    <AdminToast
      previous={{ userId: 'user_grace', notified: false, inApp: false, emailed: false }}
      name="Grace Hopper"
    />
  ),
  interact: settle
})

/** Left, and nobody can name them any more. */
export const adminToastFormerMember = defineFixture({
  width: 1280,
  render: () => (
    <AdminToast
      previous={{ userId: 'user_gone', notified: false, inApp: false, emailed: false }}
      name={null}
    />
  ),
  interact: settle
})

const notice = (overrides: Partial<OwnerChangeNotice>): OwnerChangeNotice => ({
  id: 'otn_1',
  kind: 'workspace_owner_changed',
  workspace: { id: 'sbx_1', name: 'Checkout retries', number: 41 },
  actor: { userId: 'user_grace', name: 'Grace Hopper' },
  newOwner: { userId: 'user_linus', name: 'Linus Park' },
  at: 1,
  ...overrides
})

function previousOwnerView(item: OwnerChangeNotice): CloudToastView {
  const copy = previousOwnerNotice(item, SELF_ID, () => null, translate)
  return {
    priority: 'warning',
    lines: [
      {
        key: item.id,
        text: copy.text,
        description: copy.description,
        action: { label: previousOwnerNoticeAction(translate), onClick: noop }
      }
    ]
  }
}

/**
 * What the previous owner sees, until they close it: an admin took it, an admin gave it to
 * someone else, or they gave it away themselves.
 */
export const previousOwnerNotices = defineFixture({
  width: 420,
  render: () => (
    <div className="flex flex-col gap-3 p-3">
      <CloudToastCard
        view={previousOwnerView(
          notice({ newOwner: { userId: 'user_grace', name: 'Grace Hopper' } })
        )}
        onDismiss={noop}
      />
      <CloudToastCard view={previousOwnerView(notice({}))} onDismiss={noop} />
      <CloudToastCard
        view={previousOwnerView(notice({ actor: { userId: SELF_ID, name: 'Ada Lovelace' } }))}
        onDismiss={noop}
      />
    </div>
  )
})

/** What the new owner sees, once. */
export const newOwnerNoticeOnce = defineFixture({
  width: 420,
  render: () => {
    const copy = newOwnerNotice('Checkout retries', translate)
    return (
      <div className="p-3">
        <CloudToastCard
          view={{
            priority: 'info',
            lines: [
              {
                key: 'new-owner',
                text: copy.text,
                description: copy.description,
                action: { label: copy.action, onClick: noop }
              }
            ]
          }}
          onDismiss={noop}
        />
      </div>
    )
  }
})
