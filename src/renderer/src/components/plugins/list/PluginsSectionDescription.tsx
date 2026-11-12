import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'

export function PluginsSectionDescription({ text }: { text: string }): React.JSX.Element {
  const t = useTranslate()
  const shortcut = useShortcutKeyDetails('view.plugins')
  return (
    <>
      {text}
      {shortcut.keys.length > 0 ? (
        <span className="ml-2 inline-flex items-center gap-1.5 whitespace-nowrap align-middle">
          {t(
            'auto.components.plugins.list.PluginsSectionDescription.openWith',
            'Open with (except while typing in an Orca text field)'
          )}
          <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
        </span>
      ) : null}
    </>
  )
}
