import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'

/** The paired server an `@` row's bot runs on, as the sidebar's bot row shows it; the list resolves the label once (useBotHostLabels). */
export function BotMentionHostBadge({
  label
}: {
  label: string | null | undefined
}): React.JSX.Element | null {
  return label ? <WorktreeHostContextBadge label={label} /> : null
}
