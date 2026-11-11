import { useEffect } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { SearchableSetting } from '../settings/section-layout/SearchableSetting'
import { getExperimentalSearchEntry } from '../settings/advanced/experimental-search'
import { pokesAccountKey } from './poke-copy'
import { readPokes, setPokesEnabled, usePokesState } from './pokes-store'

/** Settings → Experimental → Pokes and activity (poke and be poked, share your daily activity). Saved on Orca Cloud for this team, so it follows you. */
export function PokesExperimentalSetting(): React.JSX.Element {
  const t = useTranslate()
  const entry = getExperimentalSearchEntry().pokes
  const cloud = useAppStore((state) => state.orcaProfileAuthStatus?.cloud)
  const accountKey = pokesAccountKey(cloud?.userId, cloud?.activeOrgId)
  const pokes = usePokesState()
  const current = pokes.accountKey === accountKey ? pokes : null
  useEffect(() => {
    if (accountKey) {
      void readPokes(accountKey)
    }
  }, [accountKey])
  const enabled = current?.enabled === true
  const note = !accountKey
    ? t(
        'auto.components.teammates.pokesNeedTeam',
        'Sign in to Orca and switch to a team to use Pokes.'
      )
    : current?.error === 'save'
      ? t(
          'auto.components.teammates.pokesSaveFailed',
          'Couldn’t save. Check your connection and try again.'
        )
      : current?.error === 'read' && current.enabled === null
        ? t(
            'auto.components.teammates.unreachable',
            'Can’t reach Orca Cloud right now. Check your connection.'
          )
        : null
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-3 py-3"
      id="experimental-pokes"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>{entry.title}</Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.teammates.pokesActivitySettingCopy',
              'Teammates can poke you and see which days you used Orca Cloud. Amounts stay private.'
            )}
          </p>
          {note ? <p className="text-xs text-foreground">{note}</p> : null}
        </div>
        <Switch
          checked={enabled}
          disabled={!accountKey || current?.enabled === null || current === null}
          aria-busy={current?.saving || undefined}
          aria-label={t(
            'auto.components.teammates.pokesActivityToggle',
            'Toggle Pokes and activity'
          )}
          onCheckedChange={(next) => {
            if (accountKey && !current?.saving) {
              void setPokesEnabled(accountKey, next)
            }
          }}
        />
      </div>
    </SearchableSetting>
  )
}
