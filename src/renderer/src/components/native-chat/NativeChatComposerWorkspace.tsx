import { useMemo } from 'react'
import { Folder, GitBranch, GitCommitHorizontal, Server } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { usePublishedMachineName } from '@/components/machine-identity/use-published-machine-name'
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
        hasTransport
          ? { worktreeId, runtimeEnvironmentId: runtimeEnvironmentId ?? null }
          : undefined
      ),
    [terminalTabId, worktreeId, runtimeEnvironmentId, hasTransport]
  )
  const { hostId, machine, checkout, kind, path, branch, head } = useAppStore(useShallow(selector))

  const identity = getWorktreeGitIdentityDisplay({ branch, head })
  const label = identity?.kind === 'branch' ? identity.branchName : identity?.sourceControlLabel
  const identityCopyValue = identity?.kind === 'branch' ? identity.branchName : head
  const copyValue = async (value: string | undefined): Promise<void> => {
    if (!value) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(value)
      toast.success(translate('components.native-chat.copyMessage.copied', 'Copied'))
    } catch {
      toast.error(
        translate('components.native-chat.composerWorkspace.copyFailed', 'Failed to copy')
      )
    }
  }
  const kindLabel =
    kind === 'folder'
      ? translate('components.native-chat.composerWorkspace.folder', 'Folder')
      : kind === 'main'
        ? translate('components.native-chat.composerWorkspace.mainCheckout', 'Main checkout')
        : translate('components.native-chat.composerWorkspace.worktree', 'Worktree')

  return (
    <div className="@container mt-1 flex h-6 shrink-0 min-w-0 items-center gap-2 px-3 text-xs text-chat-foreground-faint">
      {hostId && (
        <span
          className={
            identity
              ? 'hidden min-w-0 max-w-40 shrink items-center gap-1 @lg:flex'
              : 'hidden min-w-0 max-w-40 shrink items-center gap-1 @sm:flex'
          }
        >
          <Server className="size-3.5 shrink-0" aria-hidden />
          {hostId === 'local' ? (
            <LocalMachineName name={machine ?? ''} />
          ) : (
            <span className="truncate" title={machine}>
              {machine}
            </span>
          )}
        </span>
      )}
      {checkout && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={
                identity
                  ? 'hidden min-w-0 max-w-56 shrink justify-start @sm:flex'
                  : 'min-w-0 max-w-56 shrink justify-start'
              }
              aria-label={translate(
                'components.native-chat.composerWorkspace.copyIdentity',
                'Copy {{value0}}',
                { value0: checkout }
              )}
              onClick={() => void copyValue(checkout)}
            >
              <Folder className="size-3.5" aria-hidden />
              <span className="truncate">{checkout}</span>
              <span className="shrink-0 font-normal text-chat-foreground-faint">· {kindLabel}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {path}
          </TooltipContent>
        </Tooltip>
      )}
      {identity && label && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="min-w-0 flex-1 justify-start"
              aria-label={translate(
                'components.native-chat.composerWorkspace.copyIdentity',
                'Copy {{value0}}',
                { value0: label }
              )}
              onClick={() => void copyValue(identityCopyValue)}
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

function LocalMachineName({ name }: { name: string }): React.JSX.Element {
  const published = usePublishedMachineName(name)
  return (
    <span className="truncate" title={published ?? undefined}>
      {published}
    </span>
  )
}
