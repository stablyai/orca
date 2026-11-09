import { cn } from '@/lib/utils'
import { ShortcutKeyCombo } from './ShortcutKeyCombo'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import logo from '../../../../resources/logo.svg'
import { useTranslate } from '@/i18n/use-translate'

export type LandingShortcutItem = {
  id: string
  shortcut: ShortcutKeyComboDetails
  action: string
}

export const LANDING_ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors'

/** `compact` when Home also lists cloud workspaces, so the list starts higher on the page. */
export function LandingBrand({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <div
        className={cn(
          'flex items-center justify-center border border-border/80 shadow-lg shadow-black/40',
          compact ? 'size-12 rounded-xl' : 'size-20 rounded-2xl'
        )}
        style={{ backgroundColor: '#12181e' }}
      >
        <img
          src={logo}
          alt={t('auto.components.Landing.520304a067', 'Orca logo')}
          className={compact ? 'size-7' : 'size-12'}
        />
      </div>
      <h1
        className={cn(
          'font-bold text-foreground tracking-tight',
          compact ? 'text-2xl' : 'text-4xl'
        )}
      >
        {t('auto.components.Landing.6ca6ff404e', 'ORCA')}
      </h1>
    </>
  )
}

export function LandingShortcutList({
  shortcuts
}: {
  shortcuts: readonly LandingShortcutItem[]
}): React.JSX.Element {
  return (
    <div className="mt-6 w-full max-w-xs space-y-2">
      {shortcuts.map((shortcut) => (
        <div key={shortcut.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
          <span className="text-sm text-muted-foreground">{shortcut.action}</span>
          <ShortcutKeyCombo
            keys={shortcut.shortcut.keys}
            doubleTap={shortcut.shortcut.doubleTap}
            separatorClassName="mx-0.5 text-[10px] text-muted-foreground"
          />
        </div>
      ))}
    </div>
  )
}
