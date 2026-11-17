import { useMemo } from 'react'
import { Folder, FolderGit2, GitBranch, GitCommitHorizontal, Server } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { usePublishedMachineName } from '@/components/machine-identity/use-published-machine-name'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  createNativeChatComposerWorkspaceSelector,
  type NativeChatComposerWorkspaceTarget
} from './native-chat-composer-workspace'
import { NativeChatComposerBranchPicker } from './NativeChatComposerBranchPicker'
import { NativeChatSlackMirrorItem } from '../../slack-mirror/NativeChatSlackMirrorItem'
import { NativeChatAntigravityAuthChip } from '../../antigravity-auth/NativeChatAntigravityAuthChip'

// Trim to cap height so flex centering aligns glyphs with icons; clip x only to keep descenders.
const FOOTER_TEXT =
  'min-w-0 overflow-x-clip text-ellipsis text-2xs whitespace-nowrap [text-box:trim-both_cap_alphabetic]'

export function NativeChatComposerWorkspace({
  terminalTabId,
  structuredTransport,
  pendingCreationId,
  isWorking = false
}: {
  terminalTabId: string
  pendingCreationId?: string
  structuredTransport?: NativeChatComposerWorkspaceTarget
  isWorking?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { worktreeId, runtimeEnvironmentId } = structuredTransport ?? {}
  const creationId = pendingCreationId ?? structuredTransport?.pendingCreationId
  const hasTransport = structuredTransport !== undefined
  const selector = useMemo(
    () =>
      createNativeChatComposerWorkspaceSelector(
        terminalTabId,
        hasTransport
          ? { worktreeId, runtimeEnvironmentId: runtimeEnvironmentId ?? null }
          : undefined,
        creationId
      ),
    [terminalTabId, worktreeId, runtimeEnvironmentId, hasTransport, creationId]
  )
  const {
    worktreeId: rowWorktreeId,
    repoId,
    projectName,
    hostId,
    machine,
    checkout,
    kind,
    path,
    branch,
    head
  } = useAppStore(useShallow(selector))

  const identity = getWorktreeGitIdentityDisplay({ branch, head })
  const label =
    identity?.kind === 'branch'
      ? identity.branchName
      : identity
        ? t(
            'components.native-chat.composerWorkspace.detachedCommit',
            'Commit {{head}} (not a branch)',
            {
              head: identity.shortHead
            }
          )
        : undefined
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
  // Why: for a plain folder the folder icon is literally the kind, so "· Folder" only repeats it.
  // Worktrees and main checkouts reuse that icon, so they keep a suffix to tell them apart.
  const showProjectName = Boolean(projectName && projectName !== checkout)
  const kindLabel =
    kind === 'folder'
      ? null
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
            className="h-5.5 min-w-0 max-w-full shrink justify-start"
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
      {showProjectName && (
        <span
          className="hidden min-w-14 max-w-32 shrink items-center gap-1 @sm:flex"
          title={projectName}
          data-chat-footer-project=""
        >
          <FolderGit2 className="size-3 shrink-0" aria-hidden />
          <span className={FOOTER_TEXT}>{projectName}</span>
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
                  ? 'hidden h-5.5 min-w-0 max-w-56 shrink justify-start @lg:flex'
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
              {kindLabel && !showProjectName && (
                <span
                  data-chat-footer-kind=""
                  className={`${FOOTER_TEXT} max-w-[max(0px,calc(100%_-_var(--spacing)*5))] shrink-0 font-normal text-chat-foreground-faint`}
                >
                  · {kindLabel}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {showProjectName ? [path, kindLabel].filter(Boolean).join(' · ') : path}
          </TooltipContent>
        </Tooltip>
      )}
      <NativeChatSlackMirrorItem />
      {identity && (
        <div className="flex min-w-[min(100%,calc(var(--spacing)*18))] flex-1 items-center">
          {identity.kind === 'branch' &&
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
      )}
      <span className="ml-auto flex min-w-0 shrink items-center empty:hidden">
        <NativeChatAntigravityAuthChip textClassName={FOOTER_TEXT} />
      </span>
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
