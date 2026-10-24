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
  label: string
}

const REPO_LUCIDE_ICON_DEFINITIONS: Record<RepoLucideIconName, RepoLucideIconDefinition> = {
  Folder: {
    icon: Folder,
    label: translate('auto.components.repo.repo.icon.bed2674f9d', 'Folder')
  },
  Code2: {
    icon: Code2,
    label: translate('auto.components.repo.repo.icon.65b437c381', 'Code')
  },
  SquareTerminal: {
    icon: SquareTerminal,
    label: translate('auto.components.repo.repo.icon.3eba7387ab', 'Terminal')
  },
  Bot: {
    icon: Bot,
    label: translate('auto.components.repo.repo.icon.07012dc113', 'Agent')
  },
  Package: {
    icon: Package,
    label: translate('auto.components.repo.repo.icon.787490e9bd', 'Package')
  },
  Database: {
    icon: Database,
    label: translate('auto.components.repo.repo.icon.477b28c948', 'Database')
  },
  Globe: {
    icon: Globe,
    label: translate('auto.components.repo.repo.icon.3c5a593bc8', 'Web')
  },
  Server: {
    icon: Server,
    label: translate('auto.components.repo.repo.icon.d37b4e2641', 'Server')
  },
  Cpu: {
    icon: Cpu,
    label: translate('auto.components.repo.repo.icon.b5fac337aa', 'Compute')
  },
  Layers: {
    icon: Layers,
    label: translate('auto.components.repo.repo.icon.70bef15d40', 'Layers')
  },
  Braces: {
    icon: Braces,
    label: translate('auto.components.repo.repo.icon.31826b712e', 'API')
  },
  Rocket: {
    icon: Rocket,
    label: translate('auto.components.repo.repo.icon.ecf63ec3ef', 'Launch')
  },
  Wrench: {
    icon: Wrench,
    label: translate('auto.components.repo.repo.icon.febfbe0cd5', 'Tools')
  },
  Briefcase: {
    icon: Briefcase,
    label: translate('auto.components.repo.repo.icon.4ab9433660', 'Work')
  },
  Building2: {
    icon: Building2,
    label: translate('auto.components.repo.repo.icon.c4fd14299d', 'Company')
  },
  Palette: {
    icon: Palette,
    label: translate('auto.components.repo.repo.icon.d202c659a3', 'Design')
  },
  Gauge: {
    icon: Gauge,
    label: translate('auto.components.repo.repo.icon.137bdb1856', 'Metrics')
  },
  Sparkles: {
    icon: Sparkles,
    label: translate('auto.components.repo.repo.icon.b1b8d99fc4', 'AI')
  },
  Shapes: {
    icon: Shapes,
    label: translate('auto.components.repo.repo.icon.857977b901', 'Shapes')
  },
  Box: {
    icon: Box,
    label: translate('auto.components.repo.repo.icon.0ad395d475', 'Box')
  },
  Activity: {
    icon: Activity,
    label: translate('auto.components.repo.repo.icon.a4f2c8e901', 'Activity')
  },
  BarChart3: {
    icon: BarChart3,
    label: translate('auto.components.repo.repo.icon.b7e31d4a12', 'Charts')
  },
  Bell: {
    icon: Bell,
    label: translate('auto.components.repo.repo.icon.c1d92e5f33', 'Alerts')
  },
  Blocks: {
    icon: Blocks,
    label: translate('auto.components.repo.repo.icon.d2ea3f6044', 'Blocks')
  },
  Book: {
    icon: Book,
    label: translate('auto.components.repo.repo.icon.e3fb405155', 'Docs')
  },
  Bug: {
    icon: Bug,
    label: translate('auto.components.repo.repo.icon.f4ac516266', 'Bugs')
  },
  Calendar: {
    icon: Calendar,
    label: translate('auto.components.repo.repo.icon.a5bd627377', 'Calendar')
  },
  Camera: {
    icon: Camera,
    label: translate('auto.components.repo.repo.icon.b6ce738488', 'Camera')
  },
  Cloud: {
    icon: Cloud,
    label: translate('auto.components.repo.repo.icon.c7df849599', 'Cloud')
  },
  FileText: {
    icon: FileText,
    label: translate('auto.components.repo.repo.icon.d8e095a6aa', 'Notes')
  },
  Flag: {
    icon: Flag,
    label: translate('auto.components.repo.repo.icon.e9f1a6b7bb', 'Flag')
  },
  GitBranch: {
    icon: GitBranch,
    label: translate('auto.components.repo.repo.icon.f0a2b7c8cc', 'Git')
  },
  Guitar: {
    icon: Guitar,
    label: translate('auto.components.repo.repo.icon.a1b3c9d0dd', 'Guitar')
  },
  Hammer: {
    icon: Hammer,
    label: translate('auto.components.repo.repo.icon.b2c4d0e1ee', 'Build')
  },
  Heart: {
    icon: Heart,
    label: translate('auto.components.repo.repo.icon.c3d5e1f2ff', 'Favorite')
  },
  Lightbulb: {
    icon: Lightbulb,
    label: translate('auto.components.repo.repo.icon.d4e6f20300', 'Ideas')
  },
  Music: {
    icon: Music,
    label: translate('auto.components.repo.repo.icon.e5f7141111', 'Music')
  },
  Puzzle: {
    icon: Puzzle,
    label: translate('auto.components.repo.repo.icon.f6a8252222', 'Puzzle')
  },
  Star: {
    icon: Star,
    label: translate('auto.components.repo.repo.icon.a7b9363333', 'Star')
  },
  Zap: {
    icon: Zap,
    label: translate('auto.components.repo.repo.icon.b8ca474444', 'Fast')
  }
}

export const getRepoLucideIconOptions = createLocalizedCatalog(() =>
  REPO_LUCIDE_ICON_NAMES.map((name) => ({
    name,
    label: REPO_LUCIDE_ICON_DEFINITIONS[name].label,
    icon: REPO_LUCIDE_ICON_DEFINITIONS[name].icon
  }))
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
  // Why: private-mode GHES avatars need a session cookie, so the load fails and would
  // render blank — track the failed src so a different icon still renders.
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
