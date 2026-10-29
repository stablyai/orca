import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

export function PluginsSectionDescription({ text }: { text: string }): React.JSX.Element {
  const shortcut = useShortcutKeyDetails('view.plugins')
  return (
    <>
      {text}
      {shortcut.keys.length > 0 ? (
        <span className="ml-2 inline-flex items-center gap-1.5 whitespace-nowrap align-middle">
          {translate(
            'auto.components.plugins.list.PluginsSectionDescription.openWith',
            'Open anytime with'
          )}
          <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
        </span>
      ) : null}
    </>
  )
}
