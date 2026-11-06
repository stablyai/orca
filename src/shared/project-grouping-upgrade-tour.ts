import type { ContextualTour } from './contextual-tours'

export const PROJECT_GROUPING_TIP_TOUR = {
  id: 'project-grouping-upgrade',
  steps: [
    {
      id: 'project-grouping-upgrade',
      title: 'One project for every checkout',
      body: '',
      targetSelector: '[data-project-grouping-key]',
      requiredForStart: true,
      preferredPlacement: 'right',
      primaryAction: { kind: 'complete', label: 'Got it' }
    }
  ]
} as const satisfies ContextualTour

/** The upgrade tip anchors on the header of the project its audience was captured for. */
export function withUpgradeTipTarget(
  tour: ContextualTour,
  projectId: string | undefined
): ContextualTour {
  if (tour.id !== 'project-grouping-upgrade') {
    return tour
  }
  return {
    ...tour,
    steps: tour.steps.map((step) => ({
      ...step,
      targetSelector: `[data-project-grouping-key=${JSON.stringify(`project:${projectId ?? ''}`)}]`
    }))
  }
}
