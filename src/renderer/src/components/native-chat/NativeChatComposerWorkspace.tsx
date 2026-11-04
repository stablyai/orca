import { useMemo } from 'react'
import { Folder, GitBranch, GitCommitHorizontal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getWorktreeGitIdentityDisplay } from '../../../../shared/worktree/git-identity-display'
import {
  createNativeChatComposerWorkspaceSelector,
  type NativeChatComposerWorkspaceTarget
} from './native-chat-composer-workspace'

export function NativeChatComposerWorkspace({
  terminalTabId,
  structuredTransport
}: {
  terminalTabId: string
  structuredTransport?: NativeChatComposerWorkspaceTarget
}): React.JSX.Element {
  const { worktreeId, runtimeEnvironmentId } = structuredTransport ?? {}
  const hasTransport = structuredTransport !== undefined
  const selector = useMemo(
    () =>
      createNativeChatComposerWorkspaceSelector(
        terminalTabId,
        hasTransport ? { worktreeId, runtimeEnvironmentId } : undefined
      ),
    [terminalTabId, worktreeId, runtimeEnvironmentId, hasTransport]
  )
  const { project, checkout, path, branch, head, mainCheckout } = useAppStore(useShallow(selector))

  const identity = getWorktreeGitIdentityDisplay({ branch, head })
  const label = identity?.kind === 'branch' ? identity.branchName : identity?.sourceControlLabel
  const copyValue = identity?.kind === 'branch' ? identity.branchName : head
  const copyIdentity = async (): Promise<void> => {
    if (!copyValue) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(copyValue)
      toast.success(translate('components.native-chat.copyMessage.copied', 'Copied'))
    } catch {
      toast.error(
        translate('components.native-chat.composerWorkspace.copyFailed', 'Failed to copy')
      )
    }
  }

  return (
    <div className="@container mt-1 flex h-6 shrink-0 min-w-0 items-center gap-2 overflow-hidden px-3 text-xs text-chat-foreground-faint">
      {project && (
        <span
          className="hidden min-w-0 max-w-40 shrink items-center gap-1 @sm:flex"
          title={project}
        >
          <Folder className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{project}</span>
        </span>
      )}
      {checkout && (
        <span
          className={
            identity
              ? 'hidden min-w-0 max-w-40 shrink items-center gap-1 @lg:flex'
              : 'flex min-w-0 max-w-40 shrink items-center gap-1'
          }
          title={path}
        >
          <Folder className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {project && mainCheckout
              ? translate(
                  'components.native-chat.composerWorkspace.projectCheckout',
                  'Project checkout'
                )
              : checkout}
          </span>
        </span>
      )}
      {identity && label && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="min-w-0 flex-1 justify-start font-normal text-chat-foreground-faint focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={translate(
                'components.native-chat.composerWorkspace.copyIdentity',
                'Copy {{value0}}',
                { value0: label }
              )}
              onClick={() => void copyIdentity()}
            >
              {identity.kind === 'branch' ? (
                <GitBranch className="size-3.5" aria-hidden />
              ) : (
                <GitCommitHorizontal className="size-3.5" aria-hidden />
              )}
              <span className="truncate font-mono">{label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {identity.kind === 'detached' ? identity.tooltip : label}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
