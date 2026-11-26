import {
  Eye,
  GitCompareArrows,
  GitGraph,
  ListChecks,
  ShieldAlert,
  Smartphone,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import type { EditorFileTabProps } from './editor-file-tab-props'

// Why: simulator tabs reuse this chrome with a synthetic path an icon theme would map to its file icon.
export function getEditorFileTabModeIcon(
  file: Pick<EditorFileTabProps['file'], 'mode' | 'language'>
): LucideIcon | null {
  return file.mode === 'pipeline-run'
    ? Workflow
    : file.mode === 'git-graph'
      ? GitGraph
      : file.mode === 'conflict-review'
        ? ShieldAlert
        : file.mode === 'check-details'
          ? ListChecks
          : file.mode === 'diff'
            ? GitCompareArrows
            : file.mode === 'markdown-preview'
              ? Eye
              : file.language === 'simulator'
                ? Smartphone
                : null
}
