import React from 'react'
import {
  Activity,
  BarChart3,
  Bell,
  Blocks,
  Book,
  Bot,
  Box,
  Braces,
  Briefcase,
  Bug,
  Building2,
  Calendar,
  Camera,
  Cloud,
  Code2,
  Cpu,
  Database,
  FileText,
  Flag,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  Guitar,
  Hammer,
  Heart,
  Layers,
  Lightbulb,
  Music,
  Package,
  Palette,
  Puzzle,
  Rocket,
  Server,
  // `Shapes` is lucide-react's own export name; exempted in config/oxlint-anti-slop.json.
  Shapes,
  Sparkles,
  SquareTerminal,
  Star,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { RepoIcon } from '../../../../shared/repo-icon'
import {
  REPO_LUCIDE_ICON_NAMES,
  type RepoLucideIconName
} from '../../../../shared/repo-lucide-icon-names'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

type RepoLucideIconDefinition = {
  icon: LucideIcon
  labelKey: string
  labelFallback: string
}

const REPO_LUCIDE_ICON_DEFINITIONS: Record<RepoLucideIconName, RepoLucideIconDefinition> = {
  Folder: {
    icon: Folder,
    labelKey: 'auto.components.repo.repo.icon.bed2674f9d',
    labelFallback: 'Folder'
  },
  Code2: {
    icon: Code2,
    labelKey: 'auto.components.repo.repo.icon.65b437c381',
    labelFallback: 'Code'
  },
  SquareTerminal: {
    icon: SquareTerminal,
    labelKey: 'auto.components.repo.repo.icon.3eba7387ab',
    labelFallback: 'Terminal'
  },
  Bot: {
    icon: Bot,
    labelKey: 'auto.components.repo.repo.icon.07012dc113',
    labelFallback: 'Agent'
  },
  Package: {
    icon: Package,
    labelKey: 'auto.components.repo.repo.icon.787490e9bd',
    labelFallback: 'Package'
  },
  Database: {
    icon: Database,
    labelKey: 'auto.components.repo.repo.icon.477b28c948',
    labelFallback: 'Database'
  },
  Globe: {
    icon: Globe,
    labelKey: 'auto.components.repo.repo.icon.3c5a593bc8',
    labelFallback: 'Web'
  },
  Server: {
    icon: Server,
    labelKey: 'auto.components.repo.repo.icon.d37b4e2641',
    labelFallback: 'Server'
  },
  Cpu: {
    icon: Cpu,
    labelKey: 'auto.components.repo.repo.icon.b5fac337aa',
    labelFallback: 'Compute'
  },
  Layers: {
    icon: Layers,
    labelKey: 'auto.components.repo.repo.icon.70bef15d40',
    labelFallback: 'Layers'
  },
  Braces: {
    icon: Braces,
    labelKey: 'auto.components.repo.repo.icon.31826b712e',
    labelFallback: 'API'
  },
  Rocket: {
    icon: Rocket,
    labelKey: 'auto.components.repo.repo.icon.ecf63ec3ef',
    labelFallback: 'Launch'
  },
  Wrench: {
    icon: Wrench,
    labelKey: 'auto.components.repo.repo.icon.febfbe0cd5',
    labelFallback: 'Tools'
  },
  Briefcase: {
    icon: Briefcase,
    labelKey: 'auto.components.repo.repo.icon.4ab9433660',
    labelFallback: 'Work'
  },
  Building2: {
    icon: Building2,
    labelKey: 'auto.components.repo.repo.icon.c4fd14299d',
    labelFallback: 'Company'
  },
  Palette: {
    icon: Palette,
    labelKey: 'auto.components.repo.repo.icon.d202c659a3',
    labelFallback: 'Design'
  },
  Gauge: {
    icon: Gauge,
    labelKey: 'auto.components.repo.repo.icon.137bdb1856',
    labelFallback: 'Metrics'
  },
  Sparkles: {
    icon: Sparkles,
    labelKey: 'auto.components.repo.repo.icon.b1b8d99fc4',
    labelFallback: 'AI'
  },
  Shapes: {
    icon: Shapes,
    labelKey: 'auto.components.repo.repo.icon.857977b901',
    labelFallback: 'Shapes'
  },
  Box: {
    icon: Box,
    labelKey: 'auto.components.repo.repo.icon.0ad395d475',
    labelFallback: 'Box'
  },
  Activity: {
    icon: Activity,
    labelKey: 'auto.components.repo.repo.icon.a4f2c8e901',
    labelFallback: 'Activity'
  },
  BarChart3: {
    icon: BarChart3,
    labelKey: 'auto.components.repo.repo.icon.b7e31d4a12',
    labelFallback: 'Charts'
  },
  Bell: {
    icon: Bell,
    labelKey: 'auto.components.repo.repo.icon.c1d92e5f33',
    labelFallback: 'Alerts'
  },
  Blocks: {
    icon: Blocks,
    labelKey: 'auto.components.repo.repo.icon.d2ea3f6044',
    labelFallback: 'Blocks'
  },
  Book: {
    icon: Book,
    labelKey: 'auto.components.repo.repo.icon.e3fb405155',
    labelFallback: 'Docs'
  },
  Bug: {
    icon: Bug,
    labelKey: 'auto.components.repo.repo.icon.f4ac516266',
    labelFallback: 'Bugs'
  },
  Calendar: {
    icon: Calendar,
    labelKey: 'auto.components.repo.repo.icon.a5bd627377',
    labelFallback: 'Calendar'
  },
  Camera: {
    icon: Camera,
    labelKey: 'auto.components.repo.repo.icon.b6ce738488',
    labelFallback: 'Camera'
  },
  Cloud: {
    icon: Cloud,
    labelKey: 'auto.components.repo.repo.icon.c7df849599',
    labelFallback: 'Cloud'
  },
  FileText: {
    icon: FileText,
    labelKey: 'auto.components.repo.repo.icon.d8e095a6aa',
    labelFallback: 'Notes'
  },
  Flag: {
    icon: Flag,
    labelKey: 'auto.components.repo.repo.icon.e9f1a6b7bb',
    labelFallback: 'Flag'
  },
  GitBranch: {
    icon: GitBranch,
    labelKey: 'auto.components.repo.repo.icon.f0a2b7c8cc',
    labelFallback: 'Git'
  },
  Guitar: {
    icon: Guitar,
    labelKey: 'auto.components.repo.repo.icon.a1b3c9d0dd',
    labelFallback: 'Guitar'
  },
  Hammer: {
    icon: Hammer,
    labelKey: 'auto.components.repo.repo.icon.b2c4d0e1ee',
    labelFallback: 'Build'
  },
  Heart: {
    icon: Heart,
    labelKey: 'auto.components.repo.repo.icon.c3d5e1f2ff',
    labelFallback: 'Favorite'
  },
  Lightbulb: {
    icon: Lightbulb,
    labelKey: 'auto.components.repo.repo.icon.d4e6f20300',
    labelFallback: 'Ideas'
  },
  Music: {
    icon: Music,
    labelKey: 'auto.components.repo.repo.icon.e5f7141111',
    labelFallback: 'Music'
  },
  Puzzle: {
    icon: Puzzle,
    labelKey: 'auto.components.repo.repo.icon.f6a8252222',
    labelFallback: 'Puzzle'
  },
  Star: {
    icon: Star,
    labelKey: 'auto.components.repo.repo.icon.a7b9363333',
    labelFallback: 'Star'
  },
  Zap: {
    icon: Zap,
    labelKey: 'auto.components.repo.repo.icon.b8ca474444',
    labelFallback: 'Fast'
  }
}

export const getRepoLucideIconOptions = createLocalizedCatalog(() =>
  REPO_LUCIDE_ICON_NAMES.map((name) => {
    const definition = REPO_LUCIDE_ICON_DEFINITIONS[name]
    return {
      name,
      label: translate(definition.labelKey, definition.labelFallback),
      icon: definition.icon
    }
  })
)

function isRepoLucideIconName(name: string): name is RepoLucideIconName {
  return Object.hasOwn(REPO_LUCIDE_ICON_DEFINITIONS, name)
}

export function getRepoLucideIcon(name: string | null | undefined): LucideIcon {
  if (name && isRepoLucideIconName(name)) {
    return REPO_LUCIDE_ICON_DEFINITIONS[name].icon
  }
  return Folder
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
  const imageSrc = repoIcon?.type === 'image' ? repoIcon.src : null
  // Private GHES avatars may require cookies; track failed URLs without hiding later replacement icons.
  const [failedImageSrc, setFailedImageSrc] = React.useState<string | null>(null)

  if (imageSrc !== null && failedImageSrc !== imageSrc) {
    return (
      <span className={cn('inline-flex items-center justify-center overflow-hidden', className)}>
        <img
          src={imageSrc}
          alt=""
          className={cn('size-full object-contain', iconClassName)}
          draggable={false}
          onError={() => setFailedImageSrc(imageSrc)}
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
        <span className={cn('inline-flex items-center justify-center text-[0.9em]', iconClassName)}>
          {repoIcon.emoji}
        </span>
      </span>
    )
  }

  const Icon = getRepoLucideIcon(repoIcon?.type === 'lucide' ? repoIcon.name : 'Folder')
  return (
    <span className={cn('inline-flex items-center justify-center', className)}>
      {React.createElement(Icon, {
        className: iconClassName,
        style: color ? { color } : undefined
      })}
    </span>
  )
}
