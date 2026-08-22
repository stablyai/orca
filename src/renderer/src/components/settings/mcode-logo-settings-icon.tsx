import { createElement } from 'react'
import type { LucideProps } from 'lucide-react'
import logo from '../../../../../resources/logo.svg'
import { cn } from '@/lib/utils'

export function MCodeLogoSettingsIcon({ className }: LucideProps): React.JSX.Element {
  return createElement('img', {
    src: logo,
    alt: '',
    'aria-hidden': true,
    className: cn('object-contain', className)
  })
}
