import React from 'react'
import { Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { findLocalToolchainBlock, type LocalToolchainFailureKind } from './repo-scan-failure'

const FIXES: Record<
  LocalToolchainFailureKind,
  { command: string; title: () => string; body: () => string }
> = {
  'xcode-license': {
    command: 'sudo xcodebuild -license accept',
    title: () =>
      translate(
        'auto.components.sidebar.LocalGitToolchainScanBanner.xcodeLicenseTitle',
        'Accept the Xcode license to use Git'
      ),
    body: () =>
      translate(
        'auto.components.sidebar.LocalGitToolchainScanBanner.xcodeLicenseBody',
        'macOS blocks Git until you accept it. Run this in Terminal, then switch back to Orca. It will check again automatically.'
      )
  },
  'developer-tools': {
    command: 'xcode-select --install',
    title: () =>
      translate(
        'auto.components.sidebar.LocalGitToolchainScanBanner.developerToolsTitle',
        "Install Apple's command line tools"
      ),
    body: () =>
      translate(
        'auto.components.sidebar.LocalGitToolchainScanBanner.developerToolsBody',
        "Git needs Apple's developer tools. Run this in Terminal, then switch back to Orca. It will check again automatically."
      )
  }
}

/** One sidebar-level notice for local Git toolchain failures that block every local repo at once. */
export function LocalGitToolchainScanBanner(): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const detectedByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const block = findLocalToolchainBlock(repos, detectedByRepo)
  const [pending, setPending] = React.useState(false)

  // Why: reads the store at call time so the focus listener below never needs re-subscribing.
  const rescan = React.useCallback(async () => {
    const state = useAppStore.getState()
    const blocked = findLocalToolchainBlock(state.repos, state.detectedWorktreesByRepo)?.repos ?? []
    if (blocked.length === 0) {
      return
    }
    setPending(true)
    try {
      const scans = await Promise.all(
        blocked.map((repo) =>
          state.fetchWorktrees(repo.id, { executionHostId: LOCAL_EXECUTION_HOST_ID })
        )
      )
      if (scans.every(Boolean)) {
        toast.success(
          translate(
            'auto.components.sidebar.LocalGitToolchainScanBanner.restored',
            'Git is working again. Worktrees refreshed.'
          ),
          { id: 'local-git-toolchain-restored' }
        )
      }
    } finally {
      setPending(false)
    }
  }, [])

  const isBlocked = block !== null
  React.useEffect(() => {
    if (!isBlocked) {
      return
    }
    // Why: the fix happens in Terminal, so returning to Orca is the moment to check again.
    const onFocus = (): void => void rescan()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [isBlocked, rescan])

  if (!block) {
    return null
  }
  const fix = FIXES[block.kind]
  const affected =
    block.repos.length === 1
      ? translate(
          'auto.components.sidebar.LocalGitToolchainScanBanner.affectedOne',
          'Worktree scan paused for {{value0}}',
          { value0: block.repos[0].displayName }
        )
      : translate(
          'auto.components.sidebar.LocalGitToolchainScanBanner.affectedMany',
          'Worktree scan paused for {{value0}} projects',
          { value0: block.repos.length }
        )

  return (
    <section
      role="alert"
      aria-busy={pending}
      className="mx-2 mb-2 shrink-0 rounded-md border border-destructive/50 bg-worktree-sidebar-accent/40 p-2.5 text-worktree-sidebar-foreground"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs font-semibold leading-snug">{fix.title()}</p>
          <p className="text-xs leading-snug text-muted-foreground">{fix.body()}</p>
          <code className="block select-all break-words rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">
            {fix.command}
          </code>
          <p className="truncate text-[11px] text-muted-foreground">{affected}</p>
          <div className="flex items-center gap-1.5 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() =>
                void window.api.ui
                  .writeClipboardText(fix.command)
                  .then(() =>
                    toast.success(
                      translate(
                        'auto.components.sidebar.LocalGitToolchainScanBanner.copied',
                        'Command copied'
                      )
                    )
                  )
              }
            >
              <Copy aria-hidden="true" />
              {translate(
                'auto.components.sidebar.LocalGitToolchainScanBanner.copyCommand',
                'Copy command'
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={pending}
              onClick={() => void rescan()}
            >
              <RefreshCw className={cn(pending && 'animate-spin')} aria-hidden="true" />
              {translate('auto.components.sidebar.LocalGitToolchainScanBanner.retry', 'Retry now')}
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
