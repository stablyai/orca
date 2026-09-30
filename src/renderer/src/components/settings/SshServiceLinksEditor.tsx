import { Link2, Plus, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { MAX_SSH_SERVICE_LINKS } from '../../../../shared/ssh-service-links'
import { createSshServiceLinkDraft, type SshServiceLinkDraft } from './ssh-target-draft'
import { translate } from '@/i18n/i18n'

type SshServiceLinksEditorProps = {
  links: SshServiceLinkDraft[]
  onChange: (updater: (prev: SshServiceLinkDraft[]) => SshServiceLinkDraft[]) => void
}

function appendRow(drafts: SshServiceLinkDraft[]): SshServiceLinkDraft[] {
  // Why: the cap matches the persisted limit, so the form cannot draft a list that saving truncates.
  return drafts.length >= MAX_SSH_SERVICE_LINKS ? drafts : [...drafts, createSshServiceLinkDraft()]
}

function patchRow(
  drafts: SshServiceLinkDraft[],
  index: number,
  patch: Partial<SshServiceLinkDraft>
): SshServiceLinkDraft[] {
  return drafts.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft))
}

function removeRow(drafts: SshServiceLinkDraft[], index: number): SshServiceLinkDraft[] {
  return drafts.filter((_, draftIndex) => draftIndex !== index)
}

/** Draft rows for the host's named services; trimmed and scheme-checked on save. */
export function SshServiceLinksEditor({
  links,
  onChange
}: SshServiceLinksEditorProps): React.JSX.Element {
  const atLimit = links.length >= MAX_SSH_SERVICE_LINKS

  return (
    <div className="col-span-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Link2 className="size-3.5" />
          <Label>
            {translate('auto.components.settings.SshServiceLinksEditor.title', 'Service links')}
          </Label>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={atLimit}
          onClick={() => onChange(appendRow)}
        >
          <Plus className="size-3" />
          {translate('auto.components.settings.SshServiceLinksEditor.add', 'Add link')}
        </Button>
      </div>

      {links.map((link, index) => (
        <div key={link.id} className="flex items-center gap-2">
          <Input
            id={`ssh-target-service-link-label-${link.id}`}
            value={link.label}
            aria-label={translate(
              'auto.components.settings.SshServiceLinksEditor.labelField',
              'Service link label'
            )}
            onChange={(e) => onChange((prev) => patchRow(prev, index, { label: e.target.value }))}
            placeholder={translate(
              'auto.components.settings.SshServiceLinksEditor.labelPlaceholder',
              'Grafana'
            )}
          />
          <Input
            id={`ssh-target-service-link-url-${link.id}`}
            value={link.url}
            aria-label={translate(
              'auto.components.settings.SshServiceLinksEditor.urlField',
              'Service link URL'
            )}
            onChange={(e) => onChange((prev) => patchRow(prev, index, { url: e.target.value }))}
            placeholder={translate(
              'auto.components.settings.SshServiceLinksEditor.urlPlaceholder',
              'https://grafana.example.com'
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange((prev) => removeRow(prev, index))}
            aria-label={translate(
              'auto.components.settings.SshServiceLinksEditor.remove',
              'Remove link'
            )}
          >
            <Trash2 />
          </Button>
        </div>
      ))}

      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.SshServiceLinksEditor.helper',
          'Shown as buttons on this host card. http:// and https:// URLs only, without a user name or password in the URL.'
        )}
      </p>
    </div>
  )
}
