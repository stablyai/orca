import type { SVGProps } from 'react'

/** Monochrome penguin for "runs on Linux"; belly and eyes are cut out so it reads at row size. */
export function LinuxPenguinIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        d="M12 1.5c2.6 0 4.2 2.1 4.2 4.8 0 1.4.7 2.4 1.7 3.9 1.6 2.4 2.4 5.5 1.3 8.4-.8 2.1-3.9 3.2-7.2 3.2s-6.4-1.1-7.2-3.2c-1.1-2.9-.3-6 1.3-8.4 1-1.5 1.7-2.5 1.7-3.9 0-2.7 1.6-4.8 4.2-4.8ZM8.3 15.3c0 2.8 1.6 4.9 3.7 4.9s3.7-2.1 3.7-4.9-1.6-4.6-3.7-4.6-3.7 1.8-3.7 4.6ZM10.4 4.6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3.2 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"
      />
      <ellipse cx="7.6" cy="21.4" rx="2.6" ry="1.1" />
      <ellipse cx="16.4" cy="21.4" rx="2.6" ry="1.1" />
    </svg>
  )
}
