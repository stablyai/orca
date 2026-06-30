import { Ban, MessageCircle, Shield } from 'lucide-react'
import type { ArchitectureContract, ArchitectureContractItem } from '../architecture-diagram-types'

export function contractPassed(item: ArchitectureContractItem): boolean | undefined {
  return typeof item === 'string' ? undefined : item.passed
}

export function contractSectionStats(items: readonly ArchitectureContractItem[]): {
  total: number
  passed: number
  failed: number
  unchecked: number
} {
  let passed = 0
  let failed = 0
  let unchecked = 0
  for (const item of items) {
    const result = contractPassed(item)
    if (result === true) {
      passed++
    } else if (result === false) {
      failed++
    } else {
      unchecked++
    }
  }
  return { total: items.length, passed, failed, unchecked }
}

function accentColor(stats: ReturnType<typeof contractSectionStats>): string {
  if (stats.total === 0) {
    return ''
  }
  if (stats.failed > 0) {
    return 'text-red-500'
  }
  if (stats.unchecked > 0) {
    return 'text-muted-foreground'
  }
  return 'text-emerald-500'
}

function SectionPill({
  icon: Icon,
  stats
}: {
  icon: typeof Shield
  stats: ReturnType<typeof contractSectionStats>
}): React.JSX.Element | null {
  if (stats.total === 0) {
    return null
  }
  const checked = stats.passed + stats.failed
  const label = checked > 0 ? `${stats.passed}/${stats.total}` : `${stats.total}`
  return (
    <span className={`inline-flex items-center gap-0.5 ${accentColor(stats)}`}>
      <Icon size={12} strokeWidth={2.5} />
      <span className="text-[10px] font-semibold leading-none tabular-nums">{label}</span>
    </span>
  )
}

export function ContractBadge({
  contract
}: {
  contract?: ArchitectureContract
}): React.JSX.Element | null {
  if (!contract) {
    return null
  }
  const expectStats = contractSectionStats(contract.expect ?? [])
  const askStats = contractSectionStats(contract.ask ?? [])
  const neverStats = contractSectionStats(contract.never ?? [])
  if (expectStats.total === 0 && askStats.total === 0 && neverStats.total === 0) {
    return null
  }

  return (
    <div
      className="absolute left-1.5 top-1.5 z-20 flex items-center gap-1.5 rounded bg-background/90 px-1 py-0.5"
      data-testid="architecture-contract-badge"
    >
      <SectionPill icon={Shield} stats={expectStats} />
      <SectionPill icon={MessageCircle} stats={askStats} />
      <SectionPill icon={Ban} stats={neverStats} />
    </div>
  )
}
