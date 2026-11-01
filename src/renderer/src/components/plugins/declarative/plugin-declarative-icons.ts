import { CircleDashed } from 'lucide-react'
import { createElement } from 'react'
import { resolvePluginIconGlyph } from '../plugin-icon-glyphs'

/** Renders a plugin icon name; any name this Orca does not know shows a neutral fallback glyph. */
export function PluginDeclarativeIconGlyph({
  name,
  className
}: {
  name: string
  className?: string
}): React.JSX.Element {
  return createElement(resolvePluginIconGlyph(name, CircleDashed), { className })
}
