import type { Translate } from '@/i18n/use-translate'
import {
  formatDashboardCardAge,
  type DashboardCardAgeBucket
} from '../board/dashboard-card-presentation'

export type FleetAgeFormatter = (age: DashboardCardAgeBucket) => string

export function createFleetAgeFormatter(t: Translate): FleetAgeFormatter {
  const labels = new Map<string, string>()
  return (age) => {
    const key = `${age.unit}:${age.count}`
    let label = labels.get(key)
    if (label === undefined) {
      label = formatDashboardCardAge(age, t)
      labels.set(key, label)
    }
    return label
  }
}
