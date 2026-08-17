import React from 'react'
import themeJson from '../assets/file-icons/symbol-icon-theme.json'

const svgModules = import.meta.glob('../assets/file-icons/symbols/*.svg', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

// icon-name → resolved URL, e.g. 'ts' → '/assets/ts-abc123.svg'
const iconUrl: Record<string, string> = {}
for (const [path, url] of Object.entries(svgModules)) {
  const name = path.split('/').pop()!.slice(0, -4)
  iconUrl[name] = url
}

// Stable module-level component refs — one per icon name, created once.
// Why stable: call sites do `const Icon = getSymbolsFileTypeIcon(path); <Icon />`.
// If the ref changes every render React unmounts/remounts the DOM node.
const iconComponents: Record<string, React.ComponentType<{ className?: string }>> = {}
for (const [name, url] of Object.entries(iconUrl)) {
  const capturedUrl = url
  iconComponents[name] = ({ className }: { className?: string }) => (
    <img src={capturedUrl} className={className} alt="" aria-hidden />
  )
}

const FallbackIcon: React.ComponentType<{ className?: string }> = ({ className }) => (
  <img src={iconUrl['document'] ?? iconUrl['text']} className={className} alt="" aria-hidden />
)

// Pre-sort compound extensions (those containing '.') longest-first so that
// 'stories.tsx' matches before 'tsx'.
const compoundExtensions = Object.keys(themeJson.fileExtensions)
  .filter((k) => k.includes('.'))
  .sort((a, b) => b.length - a.length)

function resolveIconName(filename: string): string | null {
  const lower = filename.toLowerCase()

  const nameMatch = (themeJson.fileNames as Record<string, string>)[lower]
  if (nameMatch) return nameMatch

  for (const compound of compoundExtensions) {
    if (lower.endsWith('.' + compound)) {
      return (themeJson.fileExtensions as Record<string, string>)[compound] ?? null
    }
  }

  const lastDot = lower.lastIndexOf('.')
  if (lastDot > 0 && lastDot < lower.length - 1) {
    const ext = lower.slice(lastDot + 1)
    return (themeJson.fileExtensions as Record<string, string>)[ext] ?? null
  }

  return null
}

function getFilename(filePath: string | undefined | null): string {
  if (!filePath) return ''
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

export function getSymbolsFileTypeIcon(
  filePath: string | undefined | null,
): React.ComponentType<{ className?: string }> {
  const filename = getFilename(filePath)
  if (!filename) return FallbackIcon
  const iconName = resolveIconName(filename)
  return (iconName && iconComponents[iconName]) || FallbackIcon
}
