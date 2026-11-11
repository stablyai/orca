import type { ContextualTour } from './contextual-tours'

export const PROJECT_GROUPING_TIP_TOUR = {
  id: 'project-grouping-upgrade',
  steps: [
    {
      id: 'project-grouping-upgrade',
      title: '',
      body: '',
      targetSelector: '[data-contextual-tour-target="project-grouping-upgrade"]',
      requiredForStart: true,
      preferredPlacement: 'right',
      hidePrimaryAction: true
    }
  ]
} as const satisfies ContextualTour
