import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginHostInstallSource } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import type { PluginGitSourceResolution } from '../../../../../shared/plugins/installation/plugin-git-resolution'
import { parsePluginInstallSource } from '../presentation/plugin-install-source'
import { pluginInstallErrorMessage } from '../presentation/plugin-error-presentation'
import {
  pluginGitInputErrorMessage,
  pluginGitResolutionErrorMessage,
  pluginGitResolutionSummary
} from '../presentation/plugin-git-install-presentation'

type PluginInstallDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstall: (source: PluginHostInstallSource) => Promise<void>
  /** The tab it opens on; remount (key) to apply a new one. */
  initialKind?: 'local-path' | 'git'
  resolveGitSource?: (args: { url: string; ref: string }) => Promise<PluginGitSourceResolution>
}

type ResolvedGitSource = Extract<PluginGitSourceResolution, { ok: true }>

function resolveGitSourceInMain(args: {
  url: string
  ref: string
}): Promise<PluginGitSourceResolution> {
  return window.api.plugins.resolveGitSource(args)
}

export function PluginInstallDialog({
  open,
  onOpenChange,
  onInstall,
  initialKind = 'local-path',
  resolveGitSource = resolveGitSourceInMain
}: PluginInstallDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<'local-path' | 'git'>(initialKind)
  const [localPath, setLocalPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  // Why a separate step: the user sees the exact version and commit before anything downloads.
  const [resolvedGit, setResolvedGit] = useState<ResolvedGitSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'resolving' | 'installing' | null>(null)
  const awaitingGitResolution = kind === 'git' && !resolvedGit
  // Why: an edit while a check is in flight must not show the old URL's version.
  const gitInputVersion = useRef(0)

  const install = async (source: PluginHostInstallSource): Promise<void> => {
    setBusy('installing')
    try {
      await onInstall(source)
    } catch (cause) {
      console.warn('[plugins] installation failed:', cause)
      setError(pluginInstallErrorMessage(cause))
      // Why: a retry checks the repository again instead of reusing a possibly moved commit.
      setResolvedGit(null)
    } finally {
      setBusy(null)
    }
  }

  const resolveGit = async (source: { url: string; ref: string }): Promise<void> => {
    setBusy('resolving')
    const version = gitInputVersion.current
    try {
      const resolution = await resolveGitSource(source)
      if (version !== gitInputVersion.current) {
        return
      }
      if (resolution.ok) {
        setResolvedGit(resolution)
      } else {
        setError(pluginGitResolutionErrorMessage(resolution))
      }
    } catch (cause) {
      if (version !== gitInputVersion.current) {
        return
      }
      console.warn('[plugins] Git source resolution failed:', cause)
      setError(pluginGitResolutionErrorMessage({ ok: false, reason: 'unreachable', error: '' }))
    } finally {
      setBusy(null)
    }
  }

  const submit = async (): Promise<void> => {
    if (kind === 'git' && resolvedGit) {
      setError(null)
      await install({
        kind: 'git',
        url: resolvedGit.url,
        ref: resolvedGit.ref,
        expectedCommit: resolvedGit.commit
      })
      return
    }
    const parsed = parsePluginInstallSource(kind, kind === 'git' ? gitUrl : localPath)
    if (!parsed.ok) {
      setError(
        parsed.reason === 'missing-local-path'
          ? translate(
              'auto.components.settings.PluginInstallDialog.localRequired',
              'Enter the plugin folder path.'
            )
          : pluginGitInputErrorMessage(parsed.reason)
      )
      return
    }
    setError(null)
    const { source } = parsed
    await (source.kind === 'git'
      ? resolveGit({ url: source.url, ref: source.ref })
      : install(source))
  }

  // Why only installing blocks closing: a version check can wait on a slow remote for minutes.
  const dismiss = (): void => {
    if (busy === 'installing') {
      return
    }
    gitInputVersion.current += 1
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : dismiss())}>
      <DialogContent surface="security" scrollable className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.PluginInstallDialog.title', 'Install plugin')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.PluginInstallDialog.description',
              'Nothing runs until you enable it.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Tabs
            value={kind}
            onValueChange={(value) => {
              setKind(value as 'local-path' | 'git')
              setError(null)
            }}
          >
            <TabsList
              aria-label={translate(
                'auto.components.settings.PluginInstallDialog.source',
                'Install source'
              )}
            >
              <TabsTrigger value="local-path">
                {translate('auto.components.settings.PluginInstallDialog.localTab', 'Local folder')}
              </TabsTrigger>
              <TabsTrigger value="git">
                {translate('auto.components.settings.PluginInstallDialog.gitTab', 'Git URL')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="local-path" className="space-y-2 pt-2">
              <Label htmlFor="plugin-local-path">
                {translate(
                  'auto.components.settings.PluginInstallDialog.localLabel',
                  'Plugin folder path'
                )}
              </Label>
              <Input
                id="plugin-local-path"
                className="font-mono text-xs"
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
                placeholder={translate(
                  'auto.components.settings.PluginInstallDialog.localPlaceholder',
                  'Path to a plugin folder'
                )}
                spellCheck={false}
                aria-invalid={kind === 'local-path' && Boolean(error)}
                aria-describedby={error ? 'plugin-install-error' : undefined}
                autoFocus
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginInstallDialog.localHelp',
                  'The folder with orca-plugin.json'
                )}
              </p>
            </TabsContent>
            <TabsContent value="git" className="space-y-2 pt-2">
              <Label htmlFor="plugin-git-url">
                {translate(
                  'auto.components.settings.PluginInstallDialog.gitLabel',
                  'Repository URL'
                )}
              </Label>
              <Input
                id="plugin-git-url"
                className="font-mono text-xs"
                value={gitUrl}
                onChange={(event) => {
                  setGitUrl(event.target.value)
                  gitInputVersion.current += 1
                  setResolvedGit(null)
                  setError(null)
                }}
                placeholder={translate(
                  'auto.components.settings.PluginInstallDialog.gitPlaceholder',
                  'https://github.com/acme/orca-notes'
                )}
                spellCheck={false}
                aria-invalid={kind === 'git' && Boolean(error)}
                aria-describedby={error ? 'plugin-install-error' : undefined}
              />
              {resolvedGit ? (
                <div className="space-y-1 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
                  <p className="text-foreground">{pluginGitResolutionSummary(resolvedGit)}</p>
                  <p className="break-all font-mono text-muted-foreground">{resolvedGit.url}</p>
                </div>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                  {translate(
                    'auto.components.settings.PluginInstallDialog.gitHelp',
                    'Paste a repository, release, or tag link. Without #tag or #commit, Orca uses the latest version tag.'
                  )}
                </p>
              )}
            </TabsContent>
          </Tabs>
          {error ? (
            <p id="plugin-install-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy === 'installing'}
              onClick={dismiss}
            >
              {translate('auto.components.settings.PluginInstallDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" className="w-31" disabled={busy !== null}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {submitLabel(busy, awaitingGitResolution)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function submitLabel(
  busy: 'resolving' | 'installing' | null,
  awaitingGitResolution: boolean
): string {
  if (busy === 'resolving') {
    return translate('auto.components.settings.PluginInstallDialog.checking', 'Checking…')
  }
  if (busy === 'installing') {
    return translate('auto.components.settings.PluginInstallDialog.installing', 'Installing…')
  }
  return awaitingGitResolution
    ? translate('auto.components.settings.PluginInstallDialog.continue', 'Continue')
    : translate('auto.components.settings.PluginInstallDialog.install', 'Install')
}
