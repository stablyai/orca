import { LayoutGrid, Smartphone, type LucideIcon } from 'lucide-react'

/** Simulator and Agents tabs carry a synthetic label as their path, so an icon theme would misread it. */
export function syntheticTabIcon(language: string | undefined): LucideIcon | null {
  if (language === 'simulator') {
    return Smartphone
  }
  return language === 'agents' ? LayoutGrid : null
}
