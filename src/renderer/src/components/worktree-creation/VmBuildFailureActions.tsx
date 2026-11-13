import type React from 'react'
import {
  Bot,
  ChevronDown,
  CreditCard,
  ExternalLink,
  Github,
  Loader2,
  LifeBuoy,
  Link2,
  LogIn,
  Monitor,
  PanelLeft,
  Pencil,
  RotateCcw,
  SquareArrowOutUpRight
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { Translate } from '@/i18n/use-translate'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import {
  copyExternalLink,
  type ExternalLinkSource
} from '@/components/open-external/copy-external-link'
import { ORCA_SUPPORT_URL, PUSH_TO_GITHUB_URL } from './vm-build-repo-actions'
import { gitHubInstallLinkSource } from '@/lib/orca-cloud/github-link-sources'
import type { VmBuildFailure } from './vm-build-failure'

export type VmBuildFailureActions = {
  onFixWithAgent: () => void
  onRetry: () => void
  onEditRecipe: () => void
  onOpenAnyway: () => void
  /** Orca Cloud, unusable sandbox: delete it and start the create on a new one. */
  onStartAgain: () => void
  onDismiss: () => void
  onSeePlans: () => void
  onOpenBilling: () => void
  /** Billing refusals: reopen the composer with the same prompt, on this computer. */
  onCreateLocally: () => void
  onSignIn: () => void
  onShowWorkspaces: () => void
  onContactSupport: () => void
  onConnectGitHub: () => void
  onPushToGitHub: () => void
}

type Action = {
  key: string
  label: string
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  /** In progress: stays focusable (aria-disabled + aria-busy) so keyboard focus isn't dropped. */
  pending?: boolean
  /** Outline even when first: a way around the problem, not its fix. */
  secondary?: boolean
  /** Opens this page in the browser: a chevron beside it offers "Copy link". */
  link?: ExternalLinkSource
  /** A More-menu row that leaves Orca for the browser: marked like the Help menu's. */
  external?: boolean
}

/** At most two visible actions; the rest sit in a More menu so the way forward stays obvious. */
function failureActions(
  failure: VmBuildFailure,
  cloud: boolean,
  canFixWithAgent: boolean,
  canManageBilling: boolean,
  signingIn: boolean,
  connectingGitHub: boolean,
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
  // Every billing refusal can still run the same prompt here instead of waiting on billing.
  const createLocally: Action = {
    key: 'local',
    label: t(
      'auto.components.worktree.creation.VmBuildFailureCard.useThisComputer',
      'Use this computer instead'
    ),
    icon: <Monitor />,
    onClick: actions.onCreateLocally,
    secondary: true
  }
  switch (failure.kind) {
    case 'plan':
      // Members can't choose a plan; their card tells them who can.
      return canManageBilling
        ? {
            primary: [
              {
                key: 'plans',
                label: t('auto.components.billing.comparePlans', 'Compare plans'),
                onClick: actions.onSeePlans
              },
              // Paying elsewhere (another device, the portal) is picked up by trying again.
              tryAgain
            ],
            more: [createLocally]
          }
        : { primary: [createLocally], more: [] }
    case 'hoursUsed':
    case 'spendCap':
    case 'payment':
      // Members can't change billing; their card tells them who can.
      return {
        primary: canManageBilling
          ? [
              {
                key: 'billing',
                label:
                  failure.kind === 'payment'
                    ? t(
                        'auto.components.worktree.creation.VmBuildFailureCard.updatePayment',
                        'Update payment method'
                      )
                    : failure.kind === 'spendCap'
                      ? t(
                          'auto.components.worktree.creation.VmBuildFailureCard.raiseSpendCap',
                          'Raise spend cap'
                        )
                      : t(
                          'auto.components.worktree.creation.VmBuildFailureCard.turnOnOverage',
                          'Turn on overage'
                        ),
                icon: <CreditCard />,
                onClick: actions.onOpenBilling
              },
              createLocally
            ]
          : [createLocally],
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
            icon: signingIn ? <Loader2 className="animate-spin" /> : <LogIn />,
            onClick: actions.onSignIn,
            pending: signingIn
          }
        ],
        more: []
      }
    case 'checks': {
      const retryChecks: Action = {
        key: 'retry',
        label: t(
          'auto.components.worktree.creation.VmBuildSheet.runChecksAgain',
          'Run checks again'
        ),
        icon: <RotateCcw />,
        onClick: actions.onRetry
      }
      const openAnyway: Action = {
        key: 'open',
        label: t('auto.components.worktree.creation.VmBuildSheet.openAnyway', 'Open anyway'),
        icon: <SquareArrowOutUpRight />,
        onClick: actions.onOpenAnyway
      }
      if (!cloud) {
        return { primary: [fix, retryChecks], more: [openAnyway, editRecipe] }
      }
      // Orca Cloud stops here only when the sandbox can't hold the workspace (no checkout, no git,
      // orcad unreachable), so opening it anyway would land in a broken workspace. A fresh sandbox
      // is the fix; checking again only helps while this one is still awake.
      const startAgain: Action = {
        key: 'start-again',
        label: t('auto.components.worktree.creation.VmBuildFailureCard.startAgain', 'Start again'),
        onClick: actions.onStartAgain
      }
      return failure.sandbox
        ? { primary: [startAgain], more: [] }
        : { primary: [startAgain, { ...retryChecks, icon: undefined }], more: [] }
    }
    case 'provision':
      return cloud
        ? { primary: [tryAgain], more: [] }
        : {
            primary: [fix, tryAgain],
            more: [editRecipe]
          }
    case 'concurrency':
    case 'memberConcurrency':
      return {
        primary: [
          {
            key: 'workspaces',
            label: t(
              'auto.components.worktree.creation.VmBuildFailureCard.showWorkspaces',
              'Show cloud workspaces'
            ),
            icon: <PanelLeft />,
            onClick: actions.onShowWorkspaces
          },
          tryAgain
        ],
        more: []
      }
    case 'snapshotMissing':
      return {
        primary: [tryAgain],
        more: [
          {
            key: 'support',
            label: t(
              'auto.components.worktree.creation.VmBuildFailureCard.contactSupport',
              'Contact support'
            ),
            icon: <LifeBuoy />,
            onClick: actions.onContactSupport,
            external: true
          },
          // A menu row can't carry the split's chevron: the same page, copied for another browser
          // (COPY-LINK-RULE, as "Copy GitHub link" under "Add a GitHub repository…").
          {
            key: 'copySupportLink',
            label: t(
              'auto.components.worktree.creation.VmBuildFailureCard.copySupportLink',
              'Copy support link'
            ),
            icon: <Link2 />,
            onClick: () => void copyExternalLink(ORCA_SUPPORT_URL)
          }
        ]
      }
    case 'githubNotConnected':
      return {
        primary: [
          {
            key: 'connectGitHub',
            label: connectingGitHub
              ? t(
                  'auto.components.worktree.creation.VmBuildFailureCard.openingGitHub',
                  'Opening GitHub…'
                )
              : t(
                  'auto.components.worktree.creation.VmBuildFailureCard.connectGitHub',
                  'Connect GitHub'
                ),
            icon: connectingGitHub ? <Loader2 className="animate-spin" /> : <Github />,
            onClick: actions.onConnectGitHub,
            pending: connectingGitHub,
            // The same install page connectOrcaCloudGitHub opens (no repository preselected).
            link: gitHubInstallLinkSource()
          },
          tryAgain
        ],
        more: []
      }
    case 'noGithubRemote':
      return {
        primary: [
          {
            key: 'pushToGitHub',
            label: t(
              'auto.components.worktree.creation.VmBuildFailureCard.howToPushToGitHub',
              'How to push to GitHub'
            ),
            icon: <SquareArrowOutUpRight />,
            onClick: actions.onPushToGitHub,
            link: PUSH_TO_GITHUB_URL
          },
          // After pushing, the same create works without leaving the sheet.
          tryAgain
        ],
        more: []
      }
    case 'unavailable':
    case 'network':
    case 'create':
    case 'cloneFailed':
      return { primary: [tryAgain], more: [] }
  }
}

export function FailureActionRow({
  failure,
  cloud,
  vmKept,
  canFixWithAgent,
  canManageBilling,
  signingIn,
  connectingGitHub,
  actions,
  t
}: {
  failure: VmBuildFailure
  cloud: boolean
  vmKept: boolean
  canFixWithAgent: boolean
  canManageBilling: boolean
  signingIn: boolean
  connectingGitHub: boolean
  actions: VmBuildFailureActions
  t: Translate
}): React.JSX.Element {
  const { primary, more } = failureActions(
    failure,
    cloud,
    canFixWithAgent,
    canManageBilling,
    signingIn,
    connectingGitHub,
    actions,
    t
  )
  // Leaving a build that still holds a VM destroys it, so say so on the button.
  const destroys = vmKept
  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary.map((action, index) =>
        action.link ? (
          <OpenExternalSplitButton
            key={action.key}
            size="sm"
            variant={index === 0 && !action.secondary ? 'default' : 'outline'}
            link={action.link}
            onClick={() => (action.pending ? undefined : action.onClick())}
            disabled={action.disabled}
            aria-disabled={action.pending || undefined}
            aria-busy={action.pending || undefined}
          >
            {action.icon}
            {action.label}
          </OpenExternalSplitButton>
        ) : (
          <Button
            key={action.key}
            type="button"
            size="sm"
            variant={index === 0 && !action.secondary ? 'default' : 'outline'}
            onClick={action.pending ? undefined : action.onClick}
            disabled={action.disabled}
            aria-disabled={action.pending || undefined}
            aria-busy={action.pending || undefined}
          >
            {action.icon}
            {action.label}
          </Button>
        )
      )}
      {more.length > 0 ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
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
                {action.external ? (
                  <ExternalLink aria-hidden className="ml-auto size-3 text-muted-foreground" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        type="button"
        // Leaving is the quiet way out; deleting a running sandbox reads destructive, set apart on the right.
        variant={destroys ? 'destructive-ghost' : 'quiet'}
        size="sm"
        onClick={actions.onDismiss}
        className="ml-auto"
      >
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
