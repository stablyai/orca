import { useMemo } from 'react'
import { Folder, GitBranch, GitCommitHorizontal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { findIndexedRepoOwnerForHost } from '@/lib/repo-owner-index'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeGitIdentityDisplay } from '../../../../shared/worktree/git-identity-display'
import { createNativeChatTabOwnerSelector } from './native-chat-file-link'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export function NativeChatComposerWorkspace({
  terminalTabId,
  structuredTransport
}: {
  terminalTabId: string
  structuredTransport?: Pick<
    NativeChatStructuredComposerTransport,
    'worktreeId' | 'runtimeEnvironmentId'
  >
}): React.JSX.Element | null {
  const selectOwner = useMemo(
    () => createNativeChatTabOwnerSelector(terminalTabId),
    [terminalTabId]
  )
  const { project, checkout, path, branch, head, mainCheckout } = useAppStore(
    useShallow((state) => {
      const worktreeId = structuredTransport?.worktreeId ?? selectOwner(state)
      const hostId = structuredTransport?.runtimeEnvironmentId
        ? toRuntimeExecutionHostId(structuredTransport.runtimeEnvironmentId)
        : getKnownExecutionHostIdForWorktree(state, worktreeId)
      const worktree = worktreeId
        ? state.getKnownWorktreeById(worktreeId, hostId ?? undefined)
        : null
      return {
        project: worktree
          ? findIndexedRepoOwnerForHost(state.repos, worktree.repoId, hostId ?? 'local')
              ?.displayName
          : undefined,
        checkout: worktree?.displayName,
        mainCheckout: worktree?.isMainWorktree,
        path: worktree?.path,
        branch: worktree?.branch,
        head: worktree?.head
      }
    })
  )
  if (!path) {
    return null
  }

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
    <div className="@container mt-1 flex h-6 min-w-0 items-center gap-2 overflow-hidden px-3 text-xs text-chat-foreground-faint">
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
        <span className="hidden min-w-0 max-w-40 shrink items-center gap-1 @lg:flex" title={path}>
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
