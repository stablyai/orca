import type React from 'react'
import {
  Bot,
  ChevronDown,
  CreditCard,
  Loader2,
  LogIn,
  Pencil,
  RotateCcw,
  Sparkles,
  SquareArrowOutUpRight,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { Translate } from '@/i18n/use-translate'
import type { VmBuildFailure } from './vm-build-failure'

export type VmBuildFailureActions = {
  onFixWithAgent: () => void
  onRetry: () => void
  onEditRecipe: () => void
  onOpenAnyway: () => void
  onDismiss: () => void
  onSeePlans: () => void
  onOpenBilling: () => void
  onSignIn: () => void
}

type Action = {
  key: string
  label: string
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
}

/** At most two visible actions; the rest sit in a More menu so the way forward stays obvious. */
function failureActions(
  failure: VmBuildFailure,
  cloud: boolean,
  canFixWithAgent: boolean,
  signingIn: boolean,
  actions: VmBuildFailureActions,
  t: Translate
): { primary: Action[]; more: Action[] } {
  const tryAgain: Action = {
    key: 'retry',
    label: t('auto.components.worktree.creation.VmBuildFailureCard.tryAgain', 'Try again'),
    icon: <RotateCcw />,
    onClick: actions.onRetry
  }
  const fix: Action = {
    key: 'fix',
    label: t('auto.components.worktree.creation.VmBuildSheet.fixWithAgent', 'Fix with agent'),
    icon: <Bot />,
    onClick: actions.onFixWithAgent,
    disabled: !canFixWithAgent
  }
  const editRecipe: Action = {
    key: 'edit',
    label: t('auto.components.worktree.creation.VmBuildSheet.editRecipe', 'Edit recipe'),
    icon: <Pencil />,
    onClick: actions.onEditRecipe
  }
  switch (failure.kind) {
    case 'plan':
      return {
        primary: [
          {
            key: 'plans',
            label: t('auto.lib.orcaCloudSession.seePlans', 'See plans'),
            icon: <Sparkles />,
            onClick: actions.onSeePlans
          }
        ],
        more: []
      }
    case 'hoursUsed':
    case 'payment':
      return {
        primary: [
          {
            key: 'billing',
            label:
              failure.kind === 'payment'
                ? t(
                    'auto.components.worktree.creation.VmBuildFailureCard.updatePayment',
                    'Update payment method'
                  )
                : t(
                    'auto.components.worktree.creation.VmBuildFailureCard.manageBilling',
                    'Manage billing'
                  ),
            icon: <CreditCard />,
            onClick: actions.onOpenBilling
          }
        ],
        more: []
      }
    case 'signIn':
      return {
        primary: [
          {
            key: 'signIn',
            label: signingIn
              ? t('auto.components.OrcaSignInProgress.signingIn', 'Signing in…')
              : t('auto.components.worktree.creation.VmBuildFailureCard.signIn', 'Sign in'),
            icon: signingIn ? <Loader2 className="motion-safe:animate-spin" /> : <LogIn />,
            onClick: actions.onSignIn,
            disabled: signingIn
          }
        ],
        more: []
      }
    case 'checks': {
      const retryChecks: Action = {
        key: 'retry',
        label: t('auto.components.worktree.creation.VmBuildSheet.retryChecks', 'Retry checks'),
        icon: <RotateCcw />,
        onClick: actions.onRetry
      }
      const openAnyway: Action = {
        key: 'open',
        label: t('auto.components.worktree.creation.VmBuildSheet.openAnyway', 'Open anyway'),
        icon: <SquareArrowOutUpRight />,
        onClick: actions.onOpenAnyway
      }
      // Hosted sandboxes have no recipe for an agent or the user to edit.
      return cloud
        ? { primary: [retryChecks, openAnyway], more: [] }
        : { primary: [fix, retryChecks], more: [openAnyway, editRecipe] }
    }
    case 'provision':
      return cloud
        ? { primary: [tryAgain], more: [] }
        : {
            primary: [
              fix,
              {
                ...tryAgain,
                label: t(
                  'auto.components.worktree.creation.WorktreeCreationPanel.34dd5ee38b',
                  'Retry'
                )
              }
            ],
            more: [editRecipe]
          }
    case 'concurrency':
    case 'unavailable':
    case 'network':
    case 'snapshotMissing':
    case 'create':
      return { primary: [tryAgain], more: [] }
  }
}

export function FailureActionRow({
  failure,
  cloud,
  vmKept,
  canFixWithAgent,
  signingIn,
  actions,
  t
}: {
  failure: VmBuildFailure
  cloud: boolean
  vmKept: boolean
  canFixWithAgent: boolean
  signingIn: boolean
  actions: VmBuildFailureActions
  t: Translate
}): React.JSX.Element {
  const { primary, more } = failureActions(failure, cloud, canFixWithAgent, signingIn, actions, t)
  // Leaving a build that still holds a VM destroys it, so say so on the button.
  const destroys = vmKept
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {primary.map((action, index) => (
        <Button
          key={action.key}
          type="button"
          size="xs"
          variant={index === 0 ? 'default' : 'outline'}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.icon}
          {action.label}
        </Button>
      ))}
      {more.length > 0 ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs">
              {t('auto.components.worktree.creation.VmBuildFailureCard.more', 'More')}
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {more.map((action) => (
              <DropdownMenuItem
                key={action.key}
                onSelect={action.onClick}
                disabled={action.disabled}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        type="button"
        variant={destroys ? 'destructive-chip' : 'ghost'}
        size="xs"
        onClick={actions.onDismiss}
        className="ml-auto"
      >
        {destroys ? <Trash2 /> : null}
        {destroys
          ? cloud
            ? t(
                'auto.components.worktree.creation.VmBuildFailureCard.deleteSandbox',
                'Delete sandbox'
              )
            : t('auto.components.worktree.creation.VmBuildFailureCard.deleteVm', 'Delete VM')
          : t('auto.components.worktree.creation.WorktreeCreationPanel.dabd226118', 'Dismiss')}
      </Button>
    </div>
  )
}
