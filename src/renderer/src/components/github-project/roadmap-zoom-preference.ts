// Why: timeline zoom is a per-device viewing preference like column widths —
// keep it out of the debounced settings write and off the remote wire.
import type { RoadmapZoom } from '../../../../shared/github/project-roadmap-timeline'

const STORAGE_KEY = 'orca.githubProject.roadmapZoom'
const DEFAULT_ZOOM: RoadmapZoom = 'month'

function isRoadmapZoom(value: string | null): value is RoadmapZoom {
  return value === 'month' || value === 'quarter' || value === 'year'
}

export function loadRoadmapZoom(): RoadmapZoom {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isRoadmapZoom(stored) ? stored : DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM
  }
}

export function saveRoadmapZoom(zoom: RoadmapZoom): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, zoom)
  } catch {
    // localStorage may be disabled — zoom just won't persist this session.
  }
}
