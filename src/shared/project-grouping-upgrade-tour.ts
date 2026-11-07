import type { ContextualTour } from './contextual-tours'

export const PROJECT_GROUPING_TIP_TOUR = {
  id: 'project-grouping-upgrade',
  steps: [
    {
      id: 'project-grouping-upgrade',
      title: 'One project for every checkout',
      body: '',
      targetSelector: '[data-sidebar-section-title="projects"]',
      requiredForStart: true,
      preferredPlacement: 'right',
      primaryAction: { kind: 'complete', label: 'Got it' }
    }
  ]
} as const satisfies ContextualTour
