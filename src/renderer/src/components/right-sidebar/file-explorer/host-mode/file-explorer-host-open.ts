import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import type { HostBrowseSource, HostFileOpenPlan } from './file-explorer-host-mode'

export function openHostFile({
  plan,
  source,
  worktreeId
}: {
  plan: HostFileOpenPlan
  source: HostBrowseSource
  worktreeId: string
}): void {
  const { openFile } = useAppStore.getState()
  const external = plan.kind === 'external'
  openFile(
    {
      filePath: plan.filePath,
      // Why: relativePath === filePath is the external-file contract the editor reads by.
      relativePath: external ? plan.filePath : plan.relativePath,
      worktreeId,
      runtimeEnvironmentId: null,
      language: detectLanguage(plan.filePath),
      mode: 'edit',
      ...(external
        ? {
            readOnly: true,
            hostBrowse: true,
            ...(source.kind === 'ssh' ? { externalSshTargetId: source.connectionId } : {})
          }
        : {})
    },
    {
      preview: true,
      focusEditor: true,
      ...(external ? { forceContentReload: true } : {}),
      suppressActiveRuntimeFallback: true
    }
  )
}
