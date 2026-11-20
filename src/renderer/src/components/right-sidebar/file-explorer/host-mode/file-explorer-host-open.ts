import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
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
      runtimeEnvironmentId: source.kind === 'runtime' ? source.environmentId : null,
      language: detectLanguage(plan.filePath),
      mode: 'edit',
      ...(external
        ? {
            readOnly: true,
            hostBrowse: true,
            ...(plan.grantId ? { terminalArtifactGrantId: plan.grantId } : {})
          }
        : {})
    },
    {
      preview: true,
      focusEditor: true,
      ...(external ? { forceContentReload: true } : {}),
      // Why: only a local open may skip the runtime; a runtime open must keep its owner.
      suppressActiveRuntimeFallback: source.kind === 'local'
    }
  )
}
