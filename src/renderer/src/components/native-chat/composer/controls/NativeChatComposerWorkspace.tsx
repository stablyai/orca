import { useMemo } from 'react'
import { Folder, GitBranch, GitCommitHorizontal, Server } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { usePublishedMachineName } from '@/components/machine-identity/use-published-machine-name'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import {
  createNativeChatComposerWorkspaceSelector,
  type NativeChatComposerWorkspaceTarget
} from './native-chat-composer-workspace'
import { NativeChatComposerBranchPicker } from './NativeChatComposerBranchPicker'

// Trim to cap height so flex centering aligns glyphs with icons; clip x only to keep descenders.
const FOOTER_TEXT =
  'min-w-0 overflow-x-clip text-ellipsis text-2xs whitespace-nowrap [text-box:trim-both_cap_alphabetic]'

export function NativeChatComposerWorkspace({
  terminalTabId,
  structuredTransport,
  isWorking = false
}: {
  terminalTabId: string
  structuredTransport?: NativeChatComposerWorkspaceTarget
  isWorking?: boolean
}): React.JSX.Element {
  const t = useTranslate()
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
  const {
    worktreeId: rowWorktreeId,
    repoId,
    hostId,
    machine,
    checkout,
    kind,
    path,
    branch,
    head
  } = useAppStore(useShallow(selector))

  const identity = getWorktreeGitIdentityDisplay({ branch, head })
  const label = identity?.kind === 'branch' ? identity.branchName : identity?.sourceControlLabel
  const identityCopyValue = identity?.kind === 'branch' ? identity.branchName : head
  const copyValue = async (value: string | undefined): Promise<void> => {
    if (!value) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(value)
      toast.success(t('components.native-chat.copyMessage.copied', 'Copied'))
    } catch {
      toast.error(t('components.native-chat.composerWorkspace.copyFailed', 'Failed to copy'))
    }
  }
  const kindLabel =
    kind === 'folder'
      ? t('components.native-chat.composerWorkspace.folder', 'Folder')
      : kind === 'main'
        ? t('components.native-chat.composerWorkspace.mainCheckout', 'Main checkout')
        : t('components.native-chat.composerWorkspace.worktree', 'Worktree')

  const copyIdentityButton =
    identity && label ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5.5 min-w-0 flex-1 justify-start"
            aria-label={t(
              'components.native-chat.composerWorkspace.copyIdentity',
              'Copy {{value0}}',
              { value0: label }
            )}
            onClick={() => void copyValue(identityCopyValue)}
          >
            {identity.kind === 'branch' ? (
              <GitBranch className="size-3" aria-hidden />
            ) : (
              <GitCommitHorizontal className="size-3" aria-hidden />
            )}
            <span className={`${FOOTER_TEXT} font-mono`}>{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {identity.kind === 'detached' ? identity.tooltip : label}
        </TooltipContent>
      </Tooltip>
    ) : null

  return (
    <div className="@container mt-1 flex h-5.5 shrink-0 min-w-0 items-center gap-1.5 px-3 text-2xs text-chat-foreground-faint">
      {hostId && (
        <span
          className={
            identity
              ? 'hidden min-w-0 max-w-40 shrink items-center gap-1 @lg:flex'
              : 'hidden min-w-0 max-w-40 shrink items-center gap-1 @sm:flex'
          }
        >
          <Server className="size-3 shrink-0" aria-hidden />
          {hostId === 'local' ? (
            <LocalMachineName name={machine ?? ''} />
          ) : (
            <span className={FOOTER_TEXT} title={machine}>
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
                  ? 'hidden h-5.5 min-w-0 max-w-56 shrink justify-start @sm:flex'
                  : 'h-5.5 min-w-0 max-w-56 shrink justify-start'
              }
              aria-label={t(
                'components.native-chat.composerWorkspace.copyIdentity',
                'Copy {{value0}}',
                { value0: checkout }
              )}
              onClick={() => void copyValue(checkout)}
            >
              <Folder className="size-3" aria-hidden />
              <span className={FOOTER_TEXT}>{checkout}</span>
              <span className="shrink-0 font-normal text-2xs text-chat-foreground-faint [text-box:trim-both_cap_alphabetic]">
                · {kindLabel}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {path}
          </TooltipContent>
        </Tooltip>
      )}
      {identity?.kind === 'branch' &&
      rowWorktreeId &&
      repoId &&
      hostId &&
      path &&
      // Direct SSH ids aren't served by the git switch route; those keep click-to-copy.
      parseExecutionHostId(hostId)?.kind !== 'ssh' ? (
        <NativeChatComposerBranchPicker
          worktreeId={rowWorktreeId}
          worktreePath={path}
          hostId={hostId}
          repoId={repoId}
          branch={identity.branchName}
          turnActive={isWorking}
          textClassName={FOOTER_TEXT}
          onCopyBranch={() => void copyValue(identity.branchName)}
          fallback={copyIdentityButton}
        />
      ) : (
        copyIdentityButton
      )}
    </div>
  )
}

function LocalMachineName({ name }: { name: string }): React.JSX.Element {
  const published = usePublishedMachineName(name)
  return (
    <span className={FOOTER_TEXT} title={published ?? undefined}>
      {published}
    </span>
  )
}
