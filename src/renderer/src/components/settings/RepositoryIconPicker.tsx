import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Github, Image, Link2, RotateCcw } from 'lucide-react'
import type { Repo } from '../../../../shared/types'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { REPO_COLORS } from '../../../../shared/constants'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { RepoIconGlyph, REPO_LUCIDE_ICON_OPTIONS } from '../repo/repo-icon'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

const EMOJI_OPTIONS = ['🚀', '✨', '💻', '🧠', '📦', '🔧', '🎨', '🌐', '📊', '🔒', '⚡', '✅']

function faviconUrlFromWebsite(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return null
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=64`
  } catch {
    return null
  }
}

export function RepositoryIconPicker({
  repo,
  updateRepo
}: {
  repo: Repo
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
}): React.JSX.Element {
  const [website, setWebsite] = useState('')
  const [loadingGitHub, setLoadingGitHub] = useState(false)
  const activeRuntimeEnvironmentId = useAppStore(
    (state) => state.settings?.activeRuntimeEnvironmentId ?? null
  )
  const selectedLucideName = repo.repoIcon?.type === 'lucide' ? repo.repoIcon.name : 'Folder'
  const selectedEmoji = repo.repoIcon?.type === 'emoji' ? repo.repoIcon.emoji : ''
  const runtimeTarget = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId }),
    [activeRuntimeEnvironmentId]
  )

  const currentIconLabel = useMemo(() => {
    if (repo.repoIcon?.type === 'image') {
      return repo.repoIcon.label ?? 'Custom image'
    }
    if (repo.repoIcon?.type === 'emoji') {
      return `${repo.repoIcon.emoji} emoji`
    }
    const label =
      REPO_LUCIDE_ICON_OPTIONS.find((option) => option.name === selectedLucideName)?.label ??
      'Folder'
    return `${label} icon with repo color`
  }, [repo.repoIcon, selectedLucideName])

  const setIcon = (repoIcon: RepoIcon | null) => updateRepo(repo.id, { repoIcon })

  const handleUploadImage = async () => {
    try {
      const result = await window.api.shell.pickRepoIconImage()
      if (!result) {
        return
      }
      setIcon({
        type: 'image',
        src: result.dataUrl,
        source: 'upload',
        label: result.fileName
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import repo icon')
    }
  }

  const handleUseWebsiteFavicon = () => {
    const src = faviconUrlFromWebsite(website)
    if (!src) {
      toast.error('Enter a valid website URL.')
      return
    }
    setIcon({ type: 'image', src, source: 'favicon', label: 'Website favicon' })
  }

  const handleUseGitHubAvatar = async () => {
    setLoadingGitHub(true)
    try {
      // Why: SSH runtime repos only exist remotely, so resolve their git remotes
      // through the active runtime instead of the local Electron main process.
      const slug =
        runtimeTarget.kind === 'environment'
          ? await callRuntimeRpc<{ owner: string; repo: string } | null>(
              runtimeTarget,
              'github.repoSlug',
              { repo: repo.id },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.repoSlug({ repoPath: repo.path, repoId: repo.id })
      if (!slug) {
        toast.error('No GitHub remote found for this repo.')
        return
      }
      setIcon({
        type: 'image',
        src: `https://github.com/${encodeURIComponent(slug.owner)}.png?size=64`,
        source: 'github',
        label: `${slug.owner}/${slug.repo}`
      })
    } catch {
      toast.error('Failed to resolve the GitHub repo.')
    } finally {
      setLoadingGitHub(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <RepoIconGlyph
          repoIcon={repo.repoIcon}
          color={repo.badgeColor}
          className="size-10 shrink-0 rounded-md border border-border/70 bg-muted/30"
          iconClassName="size-5"
        />
        <div className="min-w-0 flex-1">
          <Label className="text-sm font-semibold">Repo Icon</Label>
          <div className="mt-1 truncate text-xs text-muted-foreground">{currentIconLabel}</div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => setIcon(null)}
        >
          <RotateCcw className="size-3.5" />
          Reset
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {REPO_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => updateRepo(repo.id, { badgeColor: color })}
            className={cn(
              'size-7 rounded-full transition-all',
              repo.badgeColor === color
                ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                : 'hover:ring-1 hover:ring-muted-foreground hover:ring-offset-2 hover:ring-offset-background'
            )}
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>

      <Tabs defaultValue="icon" className="gap-3">
        <TabsList variant="line" className="h-8">
          <TabsTrigger value="icon" className="h-7 text-xs">
            Icon
          </TabsTrigger>
          <TabsTrigger value="emoji" className="h-7 text-xs">
            Emoji
          </TabsTrigger>
          <TabsTrigger value="image" className="h-7 text-xs">
            Image
          </TabsTrigger>
        </TabsList>

        <TabsContent value="icon" className="space-y-3">
          <div className="grid grid-cols-10 gap-1.5">
            {REPO_LUCIDE_ICON_OPTIONS.map((option) => (
              <Tooltip key={option.name}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={selectedLucideName === option.name ? 'secondary' : 'ghost'}
                    size="icon-xs"
                    className="size-8"
                    onClick={() => setIcon({ type: 'lucide', name: option.name })}
                    aria-label={`Use ${option.label} repo icon`}
                  >
                    <option.icon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {option.label}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="emoji" className="grid grid-cols-12 gap-1.5">
          {EMOJI_OPTIONS.map((emoji) => (
            <Button
              key={emoji}
              type="button"
              variant={selectedEmoji === emoji ? 'secondary' : 'ghost'}
              size="icon-xs"
              className="size-8 text-base"
              onClick={() => setIcon({ type: 'emoji', emoji })}
              aria-label={`Use ${emoji} repo icon`}
            >
              {emoji}
            </Button>
          ))}
        </TabsContent>

        <TabsContent value="image" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleUploadImage}
            >
              <Image className="size-3.5" />
              Upload PNG
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={loadingGitHub}
              onClick={() => void handleUseGitHubAvatar()}
            >
              <Github className="size-3.5" />
              GitHub Avatar
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="example.com"
              className="h-9 text-sm"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-2"
              onClick={handleUseWebsiteFavicon}
            >
              <Link2 className="size-3.5" />
              Favicon
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">PNG uploads must be 256KB or smaller.</p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
