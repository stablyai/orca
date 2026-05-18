import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type AgentAwakeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AgentAwakeSetting({
  settings,
  updateSettings
}: AgentAwakeSettingProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SearchableSetting
        title="Keep computer awake while agents are working"
        description="Keeps this computer awake while agents are working. The display can still turn off."
        keywords={['awake', 'sleep', 'power', 'agent', 'running', 'working']}
        className="flex items-start justify-between gap-4 px-1 py-2"
      >
        <div className="min-w-0 shrink space-y-0.5">
          <Label>Keep computer awake while agents are working</Label>
          <p className="text-xs text-muted-foreground">
            Keeps this computer awake while agents are working. The display can still turn off.
          </p>
        </div>
        <button
          role="switch"
          aria-label="Keep computer awake while agents are working"
          aria-checked={settings.keepComputerAwakeWhileAgentsRun}
          onClick={() =>
            updateSettings({
              keepComputerAwakeWhileAgentsRun: !settings.keepComputerAwakeWhileAgentsRun
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.keepComputerAwakeWhileAgentsRun ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.keepComputerAwakeWhileAgentsRun ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
    </section>
  )
}
