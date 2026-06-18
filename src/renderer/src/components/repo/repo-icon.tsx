import React from 'react'
import {
  Bot,
  Box,
  Braces,
  Briefcase,
  Building2,
  Code2,
  Cpu,
  Database,
  Folder,
  Gauge,
  Globe,
  Layers,
  Package,
  Palette,
  Rocket,
  Server,
  Shapes,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export type RepoLucideIconOption = {
  name: string
  label: string
  icon: LucideIcon
}

export const getRepoLucideIconOptions = createLocalizedCatalog(() => [
  {
    name: 'Folder',
    label: translate('auto.components.repo.repo.icon.bed2674f9d', 'Folder'),
    icon: Folder
  },
  {
    name: 'Code2',
    label: translate('auto.components.repo.repo.icon.65b437c381', 'Code'),
    icon: Code2
  },
  {
    name: 'SquareTerminal',
    label: translate('auto.components.repo.repo.icon.3eba7387ab', 'Terminal'),
    icon: SquareTerminal
  },
  {
    name: 'Bot',
    label: translate('auto.components.repo.repo.icon.07012dc113', 'Agent'),
    icon: Bot
  },
  {
    name: 'Package',
    label: translate('auto.components.repo.repo.icon.787490e9bd', 'Package'),
    icon: Package
  },
  {
    name: 'Database',
    label: translate('auto.components.repo.repo.icon.477b28c948', 'Database'),
    icon: Database
  },
  {
    name: 'Globe',
    label: translate('auto.components.repo.repo.icon.3c5a593bc8', 'Web'),
    icon: Globe
  },
  {
    name: 'Server',
    label: translate('auto.components.repo.repo.icon.d37b4e2641', 'Server'),
    icon: Server
  },
  {
    name: 'Cpu',
    label: translate('auto.components.repo.repo.icon.b5fac337aa', 'Compute'),
    icon: Cpu
  },
  {
    name: 'Layers',
    label: translate('auto.components.repo.repo.icon.70bef15d40', 'Layers'),
    icon: Layers
  },
  {
    name: 'Braces',
    label: translate('auto.components.repo.repo.icon.31826b712e', 'API'),
    icon: Braces
  },
  {
    name: 'Rocket',
    label: translate('auto.components.repo.repo.icon.ecf63ec3ef', 'Launch'),
    icon: Rocket
  },
  {
    name: 'Wrench',
    label: translate('auto.components.repo.repo.icon.febfbe0cd5', 'Tools'),
    icon: Wrench
  },
  {
    name: 'Briefcase',
    label: translate('auto.components.repo.repo.icon.4ab9433660', 'Work'),
    icon: Briefcase
  },
  {
    name: 'Building2',
    label: translate('auto.components.repo.repo.icon.c4fd14299d', 'Company'),
    icon: Building2
  },
  {
    name: 'Palette',
    label: translate('auto.components.repo.repo.icon.d202c659a3', 'Design'),
    icon: Palette
  },
  {
    name: 'Gauge',
    label: translate('auto.components.repo.repo.icon.137bdb1856', 'Metrics'),
    icon: Gauge
  },
  {
    name: 'Sparkles',
    label: translate('auto.components.repo.repo.icon.b1b8d99fc4', 'AI'),
    icon: Sparkles
  },
  {
    name: 'Shapes',
    label: translate('auto.components.repo.repo.icon.857977b901', 'Shapes'),
    icon: Shapes
  },
  { name: 'Box', label: translate('auto.components.repo.repo.icon.0ad395d475', 'Box'), icon: Box }
])

export function getRepoLucideIcon(name: string | null | undefined): LucideIcon {
  return getRepoLucideIconOptions().find((option) => option.name === name)?.icon ?? Folder
}

export function RepoIconGlyph({
  repoIcon,
  className,
  iconClassName,
  color
}: {
  repoIcon: RepoIcon | null | undefined
  className?: string
  iconClassName?: string
  color?: string
}): React.JSX.Element {
  if (repoIcon?.type === 'image') {
    return (
      <span className={cn('inline-flex items-center justify-center overflow-hidden', className)}>
        <img
          src={repoIcon.src}
          alt=""
          className={cn('size-full object-contain', iconClassName)}
          draggable={false}
        />
      </span>
    )
  }

  if (repoIcon?.type === 'emoji') {
    return (
      <span
        className={cn('inline-flex items-center justify-center leading-none', className)}
        aria-hidden="true"
      >
        <span className={cn('text-[0.9em]', iconClassName)}>{repoIcon.emoji}</span>
      </span>
    )
  }

  const Icon = getRepoLucideIcon(repoIcon?.type === 'lucide' ? repoIcon.name : 'Folder')
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      <Icon className={iconClassName} style={color ? { color } : undefined} />
    </span>
  )
}
