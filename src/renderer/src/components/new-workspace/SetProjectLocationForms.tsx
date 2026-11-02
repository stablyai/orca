import { ArrowLeft, FolderOpen, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RepoKind } from '../../../../shared/repo-types'

export function ExistingFolderForm({
  setupPath,
  setupKind,
  isSubmitting,
  onBack,
  onPathChange,
  onKindChange,
  onBrowse,
  onSubmit
}: {
  setupPath: string
  setupKind: RepoKind
  isSubmitting: boolean
  onBack: () => void
  onPathChange: (value: string) => void
  onKindChange: (value: RepoKind) => void
  onBrowse: () => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <StepBackButton
        onBack={onBack}
        label={translate(
          'auto.components.settings.RepositoryPane.existingFolder',
          'Existing folder'
        )}
      />
      <div className="flex gap-2">
        <Input
          value={setupPath}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.RepositoryPane.setupExistingFolderPathPlaceholder',
            '/path/to/project/on/host'
          )}
          className="h-9 min-w-0 flex-1 font-mono text-sm"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 shrink-0"
          onClick={onBrowse}
          aria-label={translate(
            'auto.components.sidebar.CreateProjectLocationField.f520f83a97',
            'Browse host filesystem'
          )}
        >
          <FolderOpen className="size-4" />
        </Button>
      </div>
      <Select value={setupKind} onValueChange={(value) => onKindChange(value as RepoKind)}>
        <SelectTrigger className="h-9 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="git">
            {translate('auto.components.settings.RepositoryPane.setupKindGit', 'Git repo')}
          </SelectItem>
          <SelectItem value="folder">
            {translate('auto.components.settings.RepositoryPane.setupKindFolder', 'Folder')}
          </SelectItem>
        </SelectContent>
      </Select>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!setupPath.trim() || isSubmitting}
          onClick={onSubmit}
        >
          {isSubmitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {isSubmitting
            ? translate('auto.components.settings.RepositoryPane.settingUpHost', 'Importing...')
            : translate(
                'auto.components.new.workspace.SetProjectLocationDialog.saveLocation',
                'Set location'
              )}
        </Button>
      </div>
    </div>
  )
}

export function CloneForm({
  cloneUrl,
  cloneDestination,
  isSubmitting,
  onBack,
  onCloneUrlChange,
  onCloneDestinationChange,
  onBrowse,
  onSubmit
}: {
  cloneUrl: string
  cloneDestination: string
  isSubmitting: boolean
  onBack: () => void
  onCloneUrlChange: (value: string) => void
  onCloneDestinationChange: (value: string) => void
  onBrowse: () => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <StepBackButton
        onBack={onBack}
        label={translate('auto.components.settings.RepositoryPane.cloneFromUrl', 'Clone from URL')}
      />
      <Input
        value={cloneUrl}
        onChange={(event) => onCloneUrlChange(event.target.value)}
        placeholder={translate(
          'auto.components.settings.RepositoryPane.cloneUrlPlaceholder',
          'Repository URL'
        )}
        className="h-9 min-w-0"
        spellCheck={false}
      />
      <div className="flex gap-2">
        <Input
          value={cloneDestination}
          onChange={(event) => onCloneDestinationChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.RepositoryPane.cloneDestinationPlaceholder',
            '/destination/on/host'
          )}
          className="h-9 min-w-0 flex-1 font-mono text-sm"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 shrink-0"
          onClick={onBrowse}
          aria-label={translate(
            'auto.components.sidebar.CreateProjectLocationField.f520f83a97',
            'Browse host filesystem'
          )}
        >
          <FolderOpen className="size-4" />
        </Button>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!cloneUrl.trim() || !cloneDestination.trim() || isSubmitting}
          onClick={onSubmit}
        >
          {isSubmitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {isSubmitting
            ? translate('auto.components.settings.RepositoryPane.cloningHost', 'Cloning...')
            : translate('auto.components.settings.RepositoryPane.cloneHost', 'Clone')}
        </Button>
      </div>
    </div>
  )
}

export function LocationActionButton({
  icon: Icon,
  title,
  description,
  onClick
}: {
  icon: typeof FolderOpen
  title: string
  description: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-[3.25rem] w-full items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 text-left transition-colors',
        'hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-5">{title}</span>
        <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

function StepBackButton({
  onBack,
  label
}: {
  onBack: () => void
  label: string
}): React.JSX.Element {
  return (
    <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-2" onClick={onBack}>
      <ArrowLeft className="size-4" />
      {label}
    </Button>
  )
}
