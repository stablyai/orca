import React from 'react'

export function ConductorDoneIcon({ className }: { className?: string }): React.JSX.Element {
  return React.createElement(
    'svg',
    {
      className,
      viewBox: '0 0 12 12',
      fill: 'none',
      'aria-hidden': true
    },
    React.createElement('circle', { cx: 6, cy: 6, r: 5.1, fill: 'currentColor' }),
    React.createElement('path', {
      d: 'M4 6.05 5.25 7.25 8.05 4.7',
      stroke: 'white',
      strokeWidth: 1.25,
      strokeLinecap: 'round',
      strokeLinejoin: 'round'
    })
  )
}

export function ConductorReviewIcon({ className }: { className?: string }): React.JSX.Element {
  return React.createElement(
    'svg',
    {
      className,
      viewBox: '0 0 12 12',
      fill: 'none',
      'aria-hidden': true
    },
    React.createElement('circle', {
      cx: 6,
      cy: 6,
      r: 4.9,
      fill: 'var(--background)',
      stroke: 'currentColor',
      strokeWidth: 1.45
    }),
    React.createElement('path', {
      d: 'M4.15 6.05 5.25 7.05 7.7 4.75',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round'
    })
  )
}

export function ConductorProgressIcon({ className }: { className?: string }): React.JSX.Element {
  return React.createElement(
    'svg',
    {
      className,
      viewBox: '0 0 12 12',
      fill: 'none',
      'aria-hidden': true
    },
    React.createElement('circle', {
      cx: 6,
      cy: 6,
      r: 4.9,
      fill: 'var(--background)',
      stroke: 'currentColor',
      strokeWidth: 1.45
    }),
    React.createElement('path', {
      d: 'M6 3.75v2.7',
      stroke: 'currentColor',
      strokeWidth: 1.25,
      strokeLinecap: 'round'
    })
  )
}
