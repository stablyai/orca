import { useCallback, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useOfficeHostOwner } from '@/lib/office-preview-plan'
import { useAppStore } from '@/store'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import {
  officeSkillInstallPairs,
  summarizeOfficeSkillInstall,
  toggleInSet,
  useOfficeSkillsCatalog
} from './office-skills-catalog-state'

/**
 * Installing `officecli`'s own agent skills, on the machine that owns the active workspace.
 *
 * Orca writes no Office skill content and registers no MCP server. This is one action that runs
 * the vendor's installer and reports what happened per skill and agent. The catalogue comes from
 * the tool, so adding a skill upstream shows up here without an Orca release.
 */
export function OfficeSkillsSetting(): React.JSX.Element {
  const worktreeId = useAppStore((store) => store.activeWorktreeId)
  const worktreeRoot = useAppStore((store) =>
    worktreeId ? (store.getKnownWorktreeById(worktreeId)?.path ?? null) : null
  )
  const owner = useOfficeHostOwner(worktreeId ?? '', worktreeRoot ?? '')
  const { catalog, reload } = useOfficeSkillsCatalog(owner)
  const [selectedSkills, setSelectedSkills] = useState<ReadonlySet<string>>(new Set())
  const [selectedAgents, setSelectedAgents] = useState<ReadonlySet<string>>(new Set())
  const [installing, setInstalling] = useState(false)

  const pairs = useMemo(
    () => officeSkillInstallPairs({ skills: selectedSkills, agents: selectedAgents }),
    [selectedAgents, selectedSkills]
  )

  const install = useCallback(() => {
    if (!owner || pairs.length === 0 || installing) {
      return
    }
    setInstalling(true)
    void window.api.office
      .skillsInstall({ owner, pairs })
      .then((outcome) => {
        setInstalling(false)
        if (!outcome.ok) {
          toast.error(
            translate(
              'auto.components.settings.officeSkills.installFailed',
              'Orca could not run the officecli skill installer on that machine.'
            )
          )
          return
        }
        const { installed, failed } = summarizeOfficeSkillInstall(outcome.results)
        if (failed === 0) {
          toast.success(
            translate(
              'auto.components.settings.officeSkills.installed',
              'Installed {{count}} skills.',
              { count: installed }
            )
          )
          return
        }
        // Per-pair, because one agent refusing is not the whole action failing.
        toast.message(
          translate(
            'auto.components.settings.officeSkills.installedPartial',
            'Installed {{installed}}; {{failed}} could not be installed.',
            { installed, failed }
          )
        )
      })
      .catch(() => setInstalling(false))
  }, [installing, owner, pairs])

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.officeSkills.title', 'Office document skills')}
        description={translate(
          'auto.components.settings.officeSkills.description',
          'Install officecli’s own skills so agents can author and edit Word, Excel and PowerPoint files. They are installed on the machine that owns the active workspace.'
        )}
      />
      {catalog.status === 'loading' ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : null}
      {catalog.status === 'unavailable' ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">
            {catalog.code === 'OFFICECLI_NOT_FOUND'
              ? translate(
                  'auto.components.settings.officeSkills.noBinary',
                  'officecli is not installed on that machine, so there are no skills to install.'
                )
              : translate(
                  'auto.components.settings.officeSkills.unavailable',
                  'Orca could not read the skill catalogue from that machine.'
                )}
          </p>
          <Button size="sm" variant="ghost" onClick={reload}>
            {translate('auto.components.settings.officeSkills.recheck', 'Check again')}
          </Button>
        </div>
      ) : null}
      {catalog.status === 'ready' ? (
        <div className="space-y-3">
          <SelectableRow
            label={translate('auto.components.settings.officeSkills.skills', 'Skills')}
            values={catalog.skills.map((skill) => skill.id)}
            selected={selectedSkills}
            onToggle={(value) => setSelectedSkills((current) => toggleInSet(current, value))}
          />
          <SelectableRow
            label={translate('auto.components.settings.officeSkills.agents', 'Agents')}
            values={catalog.agents.map((agent) => agent.id)}
            selected={selectedAgents}
            onToggle={(value) => setSelectedAgents((current) => toggleInSet(current, value))}
          />
          <Button size="sm" disabled={pairs.length === 0 || installing} onClick={install}>
            {installing
              ? translate('auto.components.settings.officeSkills.installing', 'Installing…')
              : translate('auto.components.settings.officeSkills.install', 'Install selected')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function SelectableRow({
  label,
  values,
  selected,
  onToggle
}: {
  label: string
  values: readonly string[]
  selected: ReadonlySet<string>
  onToggle: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <button key={value} type="button" onClick={() => onToggle(value)}>
            <Badge variant={selected.has(value) ? 'default' : 'outline'}>{value}</Badge>
          </button>
        ))}
      </div>
    </div>
  )
}
