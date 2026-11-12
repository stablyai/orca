import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Trans } from 'react-i18next'
import type { OrcaHooks } from '../../../../../../shared/orca-yaml-hook-types'
import { Button } from '../../../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../../ui/collapsible'
import { i18n, translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { renderYamlScriptPreview } from './repository-hook-settings-draft'

const EXAMPLE_TEMPLATE = `scripts:
  setup: |
    pnpm worktree:setup
  archive: |
    echo "Cleaning up before archive"
issueCommand: |
  Complete {{artifact_url}}`

function getYamlStateCopy(
  yamlState: string,
  t: Translate = translate
): { heading: string; description: string } {
  switch (yamlState) {
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
    default:
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

const YAML_CODE_COMPONENTS = { yaml: <code className="rounded bg-muted px-1 py-0.5 font-normal" /> }

// Healthy states are a plain disclosure row; only problems get a tinted card.
function YamlScriptsDisclosure({
  yamlState,
  yamlHooks,
  copiedTemplate,
  onCopyTemplate
}: {
  yamlState: 'loaded' | 'missing'
  yamlHooks: OrcaHooks | null
  copiedTemplate: boolean
  onCopyTemplate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const loaded = yamlState === 'loaded'
  return (
    <Collapsible>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <CollapsibleTrigger className="flex items-center gap-2 rounded-md text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform in-data-[state=open]:rotate-90" />
            <span>
              <Trans
                i18n={i18n}
                defaults={
                  loaded
                    ? t(
                        'auto.components.settings.RepositoryHooksSection.yamlDetected',
                        '<yaml>orca.yaml</yaml> detected'
                      )
                    : t(
                        'auto.components.settings.RepositoryHooksSection.yamlNotDetected',
                        'No <yaml>orca.yaml</yaml> detected'
                      )
                }
                components={YAML_CODE_COMPONENTS}
              />
            </span>
          </CollapsibleTrigger>
          {loaded ? null : (
            <p className="pl-5.5 text-[11px] text-muted-foreground">
              {t(
                'auto.components.settings.RepositoryHooksSection.yamlNotDetectedDescription',
                'Add one to share scripts with your team.'
              )}
            </p>
          )}
        </div>
        {loaded ? null : (
          <Button type="button" variant="outline" size="xs" onClick={onCopyTemplate}>
            {copiedTemplate
              ? t('auto.components.settings.RepositoryHooksSection.3149964b66', 'Copied')
              : t('auto.components.settings.RepositoryHooksSection.copyTemplate', 'Copy template')}
          </Button>
        )}
      </div>
      <CollapsibleContent>
        <pre className="mt-2 ml-5.5 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-[11.5px] leading-5 text-foreground">
          {loaded ? renderYamlScriptPreview(yamlHooks) : EXAMPLE_TEMPLATE}
        </pre>
      </CollapsibleContent>
    </Collapsible>
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
  if (yamlState === 'loaded' || yamlState === 'missing') {
    return (
      <YamlScriptsDisclosure
        yamlState={yamlState}
        yamlHooks={yamlHooks}
        copiedTemplate={copiedTemplate}
        onCopyTemplate={onCopyTemplate}
      />
    )
  }
  const copy = getYamlStateCopy(yamlState, t)
  const parseErrorFixes = getParseErrorFixes(t)
  return (
    <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{copy.heading}</p>
        <p className="text-xs text-muted-foreground">{copy.description}</p>
      </div>
      {yamlState === 'invalid' ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-background/60 p-3">
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
