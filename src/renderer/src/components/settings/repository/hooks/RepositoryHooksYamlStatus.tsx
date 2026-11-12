import { AlertTriangle } from 'lucide-react'
import type { OrcaHooks } from '../../../../../../shared/orca-yaml-hook-types'
import { Button } from '../../../ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { renderYamlScriptPreview } from './repository-hook-settings-draft'

const EXAMPLE_TEMPLATE = `scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"
issueCommand: |
  Complete {{artifact_url}}`

const YAML_STATE_TITLE_CLASS_NAMES: Record<string, string> = {
  loaded: 'text-emerald-700 dark:text-emerald-300',
  'update-available': 'text-amber-700 dark:text-amber-300',
  invalid: 'text-amber-700 dark:text-amber-300',
  missing: 'text-foreground'
}

function getYamlStateCopy(
  yamlState: string,
  t: Translate = translate
): { heading: string; description: string } {
  switch (yamlState) {
    case 'loaded':
      return {
        heading: t(
          'auto.components.settings.RepositoryHooksSection.56f9a4a1d0',
          'Using `orca.yaml`'
        ),
        description: t(
          'auto.components.settings.RepositoryHooksSection.ca424ff135',
          'Shared hook and issue-automation defaults are defined in the repo and available to everyone who uses it.'
        )
      }
    case 'update-available':
      return {
        heading: t(
          'auto.components.settings.RepositoryHooksSection.623e0c9f31',
          '`orca.yaml` could not be parsed'
        ),
        description: t(
          'auto.components.settings.RepositoryHooksSection.aba825233f',
          'The file contains configuration keys that this version of Orca does not recognize. You may need to update Orca, or check the file for typos.'
        )
      }
    case 'invalid':
      return {
        heading: t(
          'auto.components.settings.RepositoryHooksSection.623e0c9f31',
          '`orca.yaml` could not be parsed'
        ),
        description: t(
          'auto.components.settings.RepositoryHooksSection.0cc712b823',
          'The core configuration file exists in the repo root, but Orca could not parse the supported hook definitions yet.'
        )
      }
    default:
      return {
        heading: t(
          'auto.components.settings.RepositoryHooksSection.5a67e4793d',
          'No `orca.yaml` detected'
        ),
        description: t(
          'auto.components.settings.RepositoryHooksSection.b20c5df6ca',
          'Add an `orca.yaml` file to enable shared setup, archive, or issue-automation defaults for this repo. Example template:'
        )
      }
  }
}

function getParseErrorFixes(t: Translate = translate): string[] {
  return [
    t(
      'auto.components.settings.RepositoryHooksSection.07ba35bc68',
      'Check the indentation under `scripts:`. Hook keys should use two spaces, and command lines should use four.'
    ),
    t(
      'auto.components.settings.RepositoryHooksSection.787ca433ef',
      'Define only the supported keys: `scripts`, `setup`, `archive`, and `issueCommand`.'
    ),
    t(
      'auto.components.settings.RepositoryHooksSection.ecc73d9125',
      'Compare your file against the working template below and copy that shape if needed.'
    )
  ]
}

function ExampleTemplateCard({
  copiedTemplate,
  onCopyTemplate
}: {
  copiedTemplate: boolean
  onCopyTemplate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      <p className="text-[10px] tracking-[0.18em] text-muted-foreground">
        {t('auto.components.settings.RepositoryHooksSection.175daba180', 'Example')}{' '}
        <code className="rounded bg-muted px-1 py-0.5">
          {t('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml')}
        </code>{' '}
        {t('auto.components.settings.RepositoryHooksSection.95a0411b3e', 'template')}
      </p>
      <div className="relative rounded-lg border border-border/50 bg-background/70">
        <Button
          type="button"
          variant={copiedTemplate ? 'secondary' : 'ghost'}
          size="sm"
          className={`absolute right-2 top-2 z-10 h-6 px-2 text-[11px] ${copiedTemplate ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={onCopyTemplate}
        >
          {copiedTemplate
            ? t('auto.components.settings.RepositoryHooksSection.3149964b66', 'Copied')
            : t('auto.components.settings.RepositoryHooksSection.da37d6f10e', 'Copy')}
        </Button>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 pr-16 font-mono text-[11px] leading-5 text-muted-foreground">
          {EXAMPLE_TEMPLATE}
        </pre>
      </div>
    </div>
  )
}

export function RepositoryHooksYamlStatus({
  yamlState,
  yamlHooks,
  copiedTemplate,
  onCopyTemplate
}: {
  yamlState: string
  yamlHooks: OrcaHooks | null
  copiedTemplate: boolean
  onCopyTemplate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const copy = getYamlStateCopy(yamlState, t)
  const parseErrorFixes = getParseErrorFixes(t)
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className={`text-sm font-medium ${YAML_STATE_TITLE_CLASS_NAMES[yamlState]}`}>
          {copy.heading}
        </p>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>
      {yamlState === 'loaded' ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-[11.5px] leading-5 text-foreground">
          {renderYamlScriptPreview(yamlHooks)}
        </pre>
      ) : yamlState === 'invalid' ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                {t(
                  'auto.components.settings.RepositoryHooksSection.af49e2a19e',
                  'The file is present, but Orca could not find valid `scripts` or `issueCommand` definitions.'
                )}
              </p>
              <ol className="space-y-1.5 pl-4 text-[11.5px]">
                {parseErrorFixes.map((fix) => (
                  <li key={fix} className="list-decimal leading-5">
                    {fix}
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <ExampleTemplateCard copiedTemplate={copiedTemplate} onCopyTemplate={onCopyTemplate} />
        </div>
      ) : (
        <ExampleTemplateCard copiedTemplate={copiedTemplate} onCopyTemplate={onCopyTemplate} />
      )}
    </div>
  )
}
