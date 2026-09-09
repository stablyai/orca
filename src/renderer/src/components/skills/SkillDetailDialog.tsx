import { ClipboardCopy, FolderOpen, Share2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { sourceKindLabel } from './skill-display-labels'
import { skillAgentLabel } from './skill-agent-filter'

const updatedFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

function DetailRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/** Agent names come from the roots that reached the file, so a skill shared by
 *  several agents lists all of them rather than the coarse provider tag. */
function agentNames(
  skill: DiscoveredSkill,
  agentByRootPath: ReadonlyMap<string, string>
): string[] {
  const roots = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  const labels = roots
    .map((root) => agentByRootPath.get(root))
    .filter((agent): agent is string => Boolean(agent))
    .map(skillAgentLabel)
  return [...new Set(labels)].sort((left, right) => left.localeCompare(right))
}

export function SkillDetailDialog({
  skill,
  agentByRootPath,
  shareable,
  deletable,
  deleteDisabledReason,
  onOpenChange,
  onShare,
  onDelete
}: {
  skill: DiscoveredSkill | null
  agentByRootPath: ReadonlyMap<string, string>
  shareable: boolean
  deletable: boolean
  /** Why a reason string rather than share's bare boolean: delete is valid on a
   *  remote host, so "can't" always has a specific cause worth showing. */
  deleteDisabledReason: string | null
  onOpenChange: (open: boolean) => void
  onShare: () => void
  onDelete: () => void
}): React.JSX.Element | null {
  if (!skill) {
    return null
  }

  const copyPath = async (): Promise<void> => {
    await window.api.ui.writeClipboardText(skill.skillFilePath)
    toast.success(translate('auto.components.skills.SkillRow.pathCopied', 'Path copied'))
  }

  const revealSkill = async (): Promise<void> => {
    const result = await window.api.shell.openInFileManager(skill.skillFilePath)
    if (!result.ok) {
      toast.error(
        translate('auto.components.skills.SkillsPage.995fde8337', 'Could not reveal skill file')
      )
    }
  }

  const agents = agentNames(skill, agentByRootPath)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        {/* Why: pr-10 keeps the title clear of the dialog's own close button. */}
        <DialogHeader className="space-y-1 border-b border-border py-4 pr-10 pl-5">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="min-w-0 break-words text-base">{skill.name}</DialogTitle>
            {!skill.installed ? (
              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
                {translate('auto.components.skills.SkillsPage.35b9a724a0', 'Available')}
              </Badge>
            ) : null}
          </div>
          <DialogDescription className="text-xs">
            {sourceKindLabel(skill.sourceKind)}
            {' · '}
            {skill.sourceLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-sleek max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          <p className="whitespace-pre-wrap text-sm leading-6">
            {skill.description ??
              translate('auto.components.skills.SkillsPage.9963dff6d3', 'No description found.')}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border pt-4 text-xs">
            {agents.length > 0 ? (
              <DetailRow
                label={translate('auto.components.skills.SkillDetailDialog.agents', 'Agents')}
              >
                {agents.join(', ')}
              </DetailRow>
            ) : null}
            <DetailRow
              label={translate('auto.components.skills.SkillDetailDialog.updated', 'Updated')}
            >
              {skill.updatedAt
                ? updatedFormatter.format(new Date(skill.updatedAt))
                : translate('auto.components.skills.SkillRow.updatedUnknown', 'No date')}
            </DetailRow>
            <DetailRow label={translate('auto.components.skills.SkillRow.detailPath', 'Path')}>
              {/* Why: a labelled button beats an icon + tooltip here — the
                  tooltip would cover the very path it names. */}
              <span className="flex min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1 break-all font-mono">{skill.skillFilePath}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="-my-1 shrink-0 text-muted-foreground"
                  onClick={() => void copyPath()}
                >
                  <ClipboardCopy />
                  {translate('auto.components.skills.SkillDetailDialog.copy', 'Copy')}
                </Button>
              </span>
            </DetailRow>
          </dl>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => void revealSkill()}>
            <FolderOpen className="size-3.5" />
            {translate('auto.components.skills.SkillsPage.dc4c3328ee', 'Reveal file')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="pointer-events-auto mr-auto inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={!deletable}
                  onClick={onDelete}
                >
                  <Trash2 className="size-3.5" />
                  {translate('auto.components.skills.SkillRow.deleteSkill', 'Delete…')}
                </Button>
              </span>
            </TooltipTrigger>
            {deleteDisabledReason && !deletable ? (
              <TooltipContent side="top" sideOffset={4}>
                {deleteDisabledReason}
              </TooltipContent>
            ) : null}
          </Tooltip>
          <Button type="button" size="sm" disabled={!shareable} onClick={onShare}>
            <Share2 className="size-3.5" />
            {translate('auto.components.skills.SkillCard.d25a1b8ae6', 'Share skill')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
