import { toast } from 'sonner'
import { Bell, Info, OctagonX, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { showDeleteWorktreeFailureToast } from '../sidebar/delete-worktree-failure-toast'
import { showLocalBaseRefUpdateSuggestionToast } from '../sidebar/local-base-ref-suggestion-toast'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'

const LONG_WORKSPACE_NAME = 'feature/dev-toast-layout-with-a-long-workspace-name'
const DEV_TOAST_DESCRIPTION =
  'This is intentionally long copy for checking width, line wrapping, icon alignment, action placement, and close-button overlap in the shared toast frame.'

type DevToastAction = {
  title: string
  description: string
  icon: React.ReactNode
  onClick: () => void
}

function DevToastActionButton({ action }: { action: DevToastAction }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={action.onClick}
      className="h-auto min-h-9 justify-start gap-2 whitespace-normal px-3 py-2 text-left"
    >
      <span className="mt-0.5 text-muted-foreground">{action.icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{action.title}</span>
        <span className="block text-xs leading-4 text-muted-foreground">{action.description}</span>
      </span>
    </Button>
  )
}

function showNativeActionToast(): void {
  toast.info(
    translate(
      'auto.components.settings.DevToolsPane.nativeActionLayoutCheck',
      'Native action layout check'
    ),
    {
      description: DEV_TOAST_DESCRIPTION,
      duration: 10000,
      cancel: {
        label: translate('auto.components.settings.DevToolsPane.secondary', 'Secondary'),
        onClick: () =>
          toast.message(
            translate(
              'auto.components.settings.DevToolsPane.secondaryActionClicked',
              'Secondary action clicked'
            )
          )
      },
      action: {
        label: translate('auto.components.settings.DevToolsPane.primaryAction', 'Primary action'),
        onClick: () =>
          toast.success(
            translate(
              'auto.components.settings.DevToolsPane.primaryActionClicked',
              'Primary action clicked'
            )
          )
      }
    }
  )
}

function showBehindBaseRefToast(): void {
  let enabled = false
  showLocalBaseRefUpdateSuggestionToast(
    {
      baseRef: 'origin/canary',
      localBranch: 'canary',
      behind: 2
    },
    {
      updateSettings: async (updates) => {
        enabled = updates.refreshLocalBaseRefOnWorktreeCreate === true
      },
      getSettings: () =>
        ({
          refreshLocalBaseRefOnWorktreeCreate: enabled
        }) as AppState['settings'],
      openSettingsPage: () => {},
      openSettingsTarget: () => {}
    }
  )
}

function showDeleteFailureToast(): void {
  showDeleteWorktreeFailureToast({
    error: translate(
      'auto.components.settings.DevToolsPane.branchHasChanges',
      'branch has changes'
    ),
    canForceDelete: true,
    onViewChanges: () =>
      toast.message(
        translate(
          'auto.components.settings.DevToolsPane.viewChangesClicked',
          'View Changes clicked'
        )
      ),
    onForceDelete: () =>
      toast.error(
        translate(
          'auto.components.settings.DevToolsPane.forceDeleteClicked',
          'Force Delete clicked'
        ),
        {
          description: translate(
            'auto.components.settings.DevToolsPane.devOnlyCallback',
            'Dev-only callback.'
          )
        }
      ),
    worktreeId: 'dev-toast-worktree',
    worktreeName: LONG_WORKSPACE_NAME
  })
}

export function DevToolsPane(): React.JSX.Element {
  const actions: DevToastAction[] = [
    {
      title: translate('auto.components.settings.DevToolsPane.infoToast', 'Info toast'),
      description: translate(
        'auto.components.settings.DevToolsPane.infoToastDescription',
        'Long informational copy with no explicit action.'
      ),
      icon: <Info className="size-4" />,
      onClick: () =>
        toast.info(
          translate(
            'auto.components.settings.DevToolsPane.localCanaryBehind',
            'Local canary is behind origin/canary'
          ),
          {
            description: DEV_TOAST_DESCRIPTION,
            duration: 10000
          }
        )
    },
    {
      title: translate('auto.components.settings.DevToolsPane.successToast', 'Success toast'),
      description: translate(
        'auto.components.settings.DevToolsPane.successToastDescription',
        'Short confirmation state.'
      ),
      icon: <Sparkles className="size-4" />,
      onClick: () =>
        toast.success(
          translate('auto.components.settings.DevToolsPane.settingsSaved', 'Settings saved'),
          {
            description: translate(
              'auto.components.settings.DevToolsPane.shortSuccessCopy',
              'Short success copy.'
            )
          }
        )
    },
    {
      title: translate('auto.components.settings.DevToolsPane.errorToast', 'Error toast'),
      description: translate(
        'auto.components.settings.DevToolsPane.errorToastDescription',
        'Long error copy without recovery actions.'
      ),
      icon: <OctagonX className="size-4" />,
      onClick: () =>
        toast.error(
          translate(
            'auto.components.settings.DevToolsPane.failedToSyncWorkspaceMetadata',
            'Failed to sync workspace metadata'
          ),
          {
            description: DEV_TOAST_DESCRIPTION,
            duration: 10000
          }
        )
    },
    {
      title: translate(
        'auto.components.settings.DevToolsPane.nativeActionToast',
        'Native action toast'
      ),
      description: translate(
        'auto.components.settings.DevToolsPane.nativeActionToastDescription',
        'Uses Sonner action and cancel slots.'
      ),
      icon: <Bell className="size-4" />,
      onClick: showNativeActionToast
    },
    {
      title: translate(
        'auto.components.settings.DevToolsPane.deleteFailureToast',
        'Delete failure toast'
      ),
      description: translate(
        'auto.components.settings.DevToolsPane.deleteFailureToastDescription',
        'Custom footer with View and Force Delete.'
      ),
      icon: <Trash2 className="size-4" />,
      onClick: showDeleteFailureToast
    },
    {
      title: translate(
        'auto.components.settings.DevToolsPane.behindBaseRefToast',
        'Behind base ref toast'
      ),
      description: translate(
        'auto.components.settings.DevToolsPane.behindBaseRefToastDescription',
        'Persistent prompt with an inline Settings link and footer action.'
      ),
      icon: <Bell className="size-4" />,
      onClick: showBehindBaseRefToast
    }
  ]

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.DevToolsPane.notificationPlayground',
            'Notification playground'
          )}
          description={translate(
            'auto.components.settings.DevToolsPane.notificationPlaygroundDescription',
            'Dev-only triggers for checking toast layout, recovery actions, and long-copy wrapping.'
          )}
        />
        <Badge variant="outline" className="mt-0.5">
          {translate('auto.components.settings.DevToolsPane.devOnly', 'Dev only')}
        </Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {actions.map((action) => (
          <DevToastActionButton key={action.title} action={action} />
        ))}
      </div>
    </section>
  )
}
