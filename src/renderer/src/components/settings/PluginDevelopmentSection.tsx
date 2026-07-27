import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type PluginDevelopmentSectionProps = {
  paths: readonly string[]
  busy: boolean
  onChange: (paths: string[]) => Promise<void>
}

function saveErrorMessage(cause: unknown): string {
  console.warn('[plugins] development path update failed:', cause)
  return translate(
    'auto.components.settings.PluginDevelopmentSection.saveFailed',
    'Could not save development plugin paths.'
  )
}

export function PluginDevelopmentSection({
  paths,
  busy,
  onChange
}: PluginDevelopmentSectionProps): React.JSX.Element {
  const [pathInput, setPathInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const addPath = async (): Promise<void> => {
    const path = pathInput.trim()
    if (!path) {
      setError(
        translate(
          'auto.components.settings.PluginDevelopmentSection.pathRequired',
          'Enter a plugin folder path.'
        )
      )
      return
    }
    setError(null)
    try {
      await onChange([...paths, path])
      setPathInput('')
    } catch (cause) {
      setError(saveErrorMessage(cause))
    }
  }

  const removePath = async (index: number): Promise<void> => {
    setError(null)
    try {
      await onChange(paths.filter((_, pathIndex) => pathIndex !== index))
    } catch (cause) {
      setError(saveErrorMessage(cause))
    }
  }

  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md py-1.5 pr-2 text-[13px] font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        {translate('auto.components.settings.PluginDevelopmentSection.title', 'Development')}
      </summary>
      <div className="space-y-3 pb-1 pl-5 pt-1">
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
          {translate(
            'auto.components.settings.PluginDevelopmentSection.help',
            'Load plugins directly from folders on this computer while you develop them. Dev plugins still require permission review. Workers run on this desktop host; SSH workspace actions route through Orca, so paths here are desktop paths.'
          )}
        </p>
        {paths.map((path, index) => (
          <div key={`${path}-${index}`} className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs"
              title={path}
            >
              {path}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => void removePath(index)}
            >
              {translate('auto.components.settings.PluginDevelopmentSection.remove', 'Remove')}
            </Button>
          </div>
        ))}
        <form
          className="flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void addPath()
          }}
        >
          <Label htmlFor="plugin-development-path" className="sr-only">
            {translate(
              'auto.components.settings.PluginDevelopmentSection.pathLabel',
              'Development plugin folder path'
            )}
          </Label>
          <Input
            id="plugin-development-path"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            className="h-8 min-w-0 font-mono text-xs"
            placeholder={translate(
              'auto.components.settings.PluginDevelopmentSection.placeholder',
              '/Users/you/plugins/my-plugin or C:\\Users\\you\\plugins\\my-plugin'
            )}
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'plugin-development-path-error' : undefined}
          />
          <Button type="submit" variant="outline" size="sm" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {translate('auto.components.settings.PluginDevelopmentSection.add', 'Add path')}
          </Button>
        </form>
        {error ? (
          <p id="plugin-development-path-error" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  )
}
