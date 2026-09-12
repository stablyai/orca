import { AlertTriangle } from 'lucide-react'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SkillSharePreview } from '../../../../shared/skill-sharing-contract'
import { fileCountLabel, skillCountLabel } from './skill-display-labels'
import { byteLabel, sensitiveShareFiles, summarizeShareRisk } from './skill-share-preview-summary'
import { SkillDescriptionDisclosure } from './SkillDescriptionDisclosure'
import { SkillDisclosureTrigger } from './SkillDisclosureTrigger'

function SensitiveFileList({ preview }: { preview: SkillSharePreview }): React.JSX.Element {
  return (
    <ul className="scrollbar-sleek mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
      {sensitiveShareFiles(preview).map((file) => (
        <li key={file.path} className="flex items-baseline gap-2 text-[11px]">
          <span className="min-w-0 flex-1 break-all font-mono" title={file.path}>
            {file.path}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {file.executable
              ? translate('auto.components.skills.share.fileExecutable', 'executable')
              : translate('auto.components.skills.share.fileScript', 'script')}
          </span>
        </li>
      ))}
    </ul>
  )
}

function BundleSkillList({ preview }: { preview: SkillSharePreview }): React.JSX.Element {
  return (
    <div className="scrollbar-sleek mt-2 max-h-56 space-y-2 overflow-y-auto rounded-md border border-border p-2">
      {(preview.skills ?? []).map((skill) => (
        <div key={skill.id} className="flex items-start justify-between gap-3 text-xs">
          <div className="min-w-0">
            <p className="truncate font-medium">{skill.name}</p>
            <p className="truncate text-muted-foreground">{skill.description}</p>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {fileCountLabel(skill.fileCount)} · {byteLabel(skill.totalBytes)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function SkillSharePackageSummary({
  preview
}: {
  preview: SkillSharePreview
}): React.JSX.Element {
  const skillCount = preview.skillCount ?? preview.skills?.length ?? 1
  const bundle = skillCount > 1
  const risk = summarizeShareRisk(preview)
  return (
    <section className="space-y-2">
      <div className="min-w-0">
        {/* Why: a bundle's package name is synthesized ("shared-skills"), so the
            count is the only honest heading; the list below names the members. */}
        <h3 className="truncate text-sm font-semibold">
          {bundle ? skillCountLabel(skillCount) : preview.name}
        </h3>
        {bundle ? null : <SkillDescriptionDisclosure description={preview.description} />}
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{fileCountLabel(preview.fileCount)}</span>
          <span aria-hidden>·</span>
          <span>{byteLabel(preview.totalBytes)}</span>
          <span aria-hidden>·</span>
          <span className={cn('inline-flex items-center gap-1', risk.risky && 'text-foreground')}>
            {risk.risky ? <AlertTriangle className="size-3.5" /> : null}
            {risk.label}
          </span>
        </p>
      </div>

      {risk.risky ? (
        <Collapsible>
          <SkillDisclosureTrigger
            label={translate(
              'auto.components.skills.share.reviewFiles',
              'Review files that can run'
            )}
          />
          <CollapsibleContent className="collapsible-height-content">
            <SensitiveFileList preview={preview} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {bundle && (preview.skills?.length ?? 0) > 0 ? (
        <Collapsible defaultOpen>
          <SkillDisclosureTrigger
            label={translate('auto.components.skills.share.reviewSkills', 'Review included skills')}
          />
          <CollapsibleContent className="collapsible-height-content">
            <BundleSkillList preview={preview} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  )
}
