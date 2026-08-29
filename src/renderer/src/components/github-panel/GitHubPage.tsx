import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useGitHubAccountStatus } from './useGitHubAccountStatus'
import { GitHubSignInPanel } from './GitHubSignInPanel'
import { GitHubRepoList } from './GitHubRepoList'

export default function GitHubPage(): React.JSX.Element {
  const closePage = useAppStore((state) => state.closeGithubPage)
  const { status, loading, refresh, disconnect } = useGitHubAccountStatus()
  const configured = status?.configured === true

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (target.dataset.escapeClearsValue === 'true') {
        return
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      closePage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePage])

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-center gap-2 px-3 pb-3 md:px-5"
        // Why: no stacked center titlebar on this page; keep the title clear of Windows/Linux window controls.
        style={
          {
            paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))'
          } as React.CSSProperties
        }
      >
        <h1 className="flex-1 truncate text-base font-semibold leading-8">
          {translate('auto.components.github-panel.GitHubPage.title', 'My GitHub')}
        </h1>
        {configured ? (
          <div className="flex items-center gap-2">
            {status?.avatarUrl ? (
              <img src={status.avatarUrl} alt="" className="size-5 rounded-full" />
            ) : null}
            <span className="text-[12px] text-muted-foreground">
              {status?.login ??
                (status?.source === 'environment'
                  ? translate(
                      'auto.components.github-panel.GitHubPage.envAccount',
                      'via environment token'
                    )
                  : null)}
            </span>
            {status?.source === 'stored' ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect()}>
                {translate('auto.components.github-panel.GitHubPage.disconnect', 'Disconnect')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {translate('auto.components.github-panel.GitHubPage.loading', 'Loading…')}
        </div>
      ) : configured ? (
        <GitHubRepoList />
      ) : (
        <GitHubSignInPanel
          deviceFlowAvailable={status?.deviceFlowAvailable === true}
          onConnected={refresh}
        />
      )}
    </main>
  )
}
