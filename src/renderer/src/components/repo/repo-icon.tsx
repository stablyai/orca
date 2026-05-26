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

export type RepoLucideIconOption = {
  name: string
  label: string
  icon: LucideIcon
}

export const REPO_LUCIDE_ICON_OPTIONS: RepoLucideIconOption[] = [
  { name: 'Folder', label: 'Folder', icon: Folder },
  { name: 'Code2', label: 'Code', icon: Code2 },
  { name: 'SquareTerminal', label: 'Terminal', icon: SquareTerminal },
  { name: 'Bot', label: 'Agent', icon: Bot },
  { name: 'Package', label: 'Package', icon: Package },
  { name: 'Database', label: 'Database', icon: Database },
  { name: 'Globe', label: 'Web', icon: Globe },
  { name: 'Server', label: 'Server', icon: Server },
  { name: 'Cpu', label: 'Compute', icon: Cpu },
  { name: 'Layers', label: 'Layers', icon: Layers },
  { name: 'Braces', label: 'API', icon: Braces },
  { name: 'Rocket', label: 'Launch', icon: Rocket },
  { name: 'Wrench', label: 'Tools', icon: Wrench },
  { name: 'Briefcase', label: 'Work', icon: Briefcase },
  { name: 'Building2', label: 'Company', icon: Building2 },
  { name: 'Palette', label: 'Design', icon: Palette },
  { name: 'Gauge', label: 'Metrics', icon: Gauge },
  { name: 'Sparkles', label: 'AI', icon: Sparkles },
  { name: 'Shapes', label: 'Shapes', icon: Shapes },
  { name: 'Box', label: 'Box', icon: Box }
]

export function getRepoLucideIcon(name: string | null | undefined): LucideIcon {
  return REPO_LUCIDE_ICON_OPTIONS.find((option) => option.name === name)?.icon ?? Folder
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
