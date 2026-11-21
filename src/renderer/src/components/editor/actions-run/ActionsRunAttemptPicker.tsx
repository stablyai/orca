import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

export function ActionsRunAttemptPicker({
  owner,
  selected,
  latest,
  onChange
}: {
  owner: string
  selected: number | null
  latest?: number
  onChange: (attempt: number | null) => void
}) {
  return (
    <form
      key={`${owner}:${selected ?? 'latest'}:${latest ?? ''}`}
      className="mt-3 flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(event) => {
        event.preventDefault()
        const attempt = Number(new FormData(event.currentTarget).get('attempt'))
        if (Number.isSafeInteger(attempt) && attempt > 0 && (!latest || attempt <= latest)) {
          onChange(attempt)
        }
      }}
    >
      <label className="flex items-center gap-2">
        {translate('actions.attempt', 'Attempt')}
        <Input
          name="attempt"
          type="number"
          min={1}
          max={latest}
          step={1}
          required
          defaultValue={selected ?? latest ?? 1}
          className="h-8 w-24"
        />
      </label>
      <Button type="submit" variant="outline" size="sm">
        {translate('actions.viewAttempt', 'View attempt')}
      </Button>
      <Button
        type="button"
        variant={selected === null ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={selected === null}
        onClick={() => onChange(null)}
      >
        {translate('actions.latestAttempt', 'Latest attempt')}
      </Button>
      {latest && (
        <span className="text-muted-foreground">
          {translate('actions.latestAttemptNumber', 'Latest: {{attempt}}', { attempt: latest })}
        </span>
      )}
    </form>
  )
}
