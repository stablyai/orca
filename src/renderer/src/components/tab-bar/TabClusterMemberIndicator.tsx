import type { TabClusterColor } from '../../../../shared/tab-types'
import { cn } from '@/lib/utils'
import { TAB_CLUSTER_COLOR_CLASSES } from './tab-cluster-colors'

export function TabClusterMemberIndicator({
  color
}: {
  color: TabClusterColor
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 h-0.5',
        TAB_CLUSTER_COLOR_CLASSES[color]
      )}
    />
  )
}
