// A diff tab in another person's Home list: the file's changes, read on the agent's host, to read.
import { Suspense, useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget } from '@/lib/bot-hosts'
import { getRuntimeGitDiff } from '@/runtime/source-control/git/runtime-git-diff-client'
import type { Bot } from '../../../../../shared/bot-types'
import type { GitDiffResult } from '../../../../../shared/git/diff/git-diff-compare-types'
import type { RuntimeMobileSessionFileTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { DiffViewer } from '../../editor/editor-lazy-views'
import { useBotHome } from '../../settings/bots/use-bot-home-file'

type DiffRead = { state: 'reading' } | { state: 'failed' } | { state: 'read'; diff: GitDiffResult }

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function ViewedFileDiff({
  bot,
  tab
}: {
  bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'>
  tab: Pick<
    RuntimeMobileSessionFileTab,
    'filePath' | 'relativePath' | 'language' | 'diffSource' | 'oldPath'
  >
}): React.JSX.Element {
  const t = useTranslate()
  const home = useBotHome(bot)
  const [read, setRead] = useState<DiffRead>({ state: 'reading' })
  const staged = tab.diffSource === 'staged'
  useEffect(() => {
    if (!home) {
      return
    }
    let current = true
    setRead({ state: 'reading' })
    getRuntimeGitDiff(
      {
        target: botTarget(home.bot),
        worktreeId: folderWorkspaceKey(home.bot.folderWorkspaceId),
        worktreePath: home.folderPath
      },
      { filePath: tab.relativePath, staged, ...(tab.oldPath ? { oldPath: tab.oldPath } : {}) }
    )
      .then((diff) => current && setRead({ state: 'read', diff }))
      .catch(() => current && setRead({ state: 'failed' }))
    return () => {
      current = false
    }
  }, [home, tab.relativePath, tab.oldPath, staged])
  if (read.state === 'failed') {
    return (
      <Notice>
        {t('bots.teammateTabs.diffUnreadable', 'Could not read the changes to {{path}}.', {
          path: tab.relativePath
        })}
      </Notice>
    )
  }
  if (read.state === 'reading') {
    return (
      <Notice>
        {t('bots.teammateTabs.fileReading', 'Reading {{path}}…', { path: tab.relativePath })}
      </Notice>
    )
  }
  if (read.diff.kind === 'binary') {
    return <Notice>{t('bots.teammateTabs.diffBinary', 'Binary file changed')}</Notice>
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <DiffViewer
          modelKey={`viewed-diff:${bot.hostId}:${bot.folderWorkspaceId}:${staged}:${tab.relativePath}`}
          originalContent={read.diff.originalContent}
          modifiedContent={read.diff.modifiedContent}
          language={tab.language}
          filePath={tab.filePath}
          relativePath={tab.relativePath}
          sideBySide={false}
        />
      </Suspense>
    </div>
  )
}
