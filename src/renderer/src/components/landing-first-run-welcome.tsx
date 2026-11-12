import { useRef, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../store/index'
import { LandingLogoTile } from './landing-layout'

/** The home folder opens as an ordinary folder project, named the way the shell writes it. */
export const HOME_FOLDER_PROJECT_NAME = '~'

/**
 * Opens the home folder as a folder project (or reveals it if it was added before), the way a
 * fresh profile used to start. The folder add reveals its workspace and opens its terminal.
 */
export async function openHomeFolderProject(): Promise<void> {
  const home = await window.api.repos.getHomeFolderPath()
  await useAppStore.getState().addNonGitFolder(home, { displayName: HOME_FOLDER_PROJECT_NAME })
}

/**
 * First run, with no project yet: one clear next step (add a repository) instead of a terminal
 * in the home folder. The home-folder terminal stays one quiet click away.
 */
export function LandingFirstRunWelcome({
  notice
}: {
  /** Setup nudges (missing Git, GitHub CLI) keep their place under the intro. */
  notice?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  const [openingHome, setOpeningHome] = useState(false)
  // A double click lands before the disabled state renders: the ref keeps it to one add.
  const openingHomeRef = useRef(false)
  const mountedRef = useMountedRef()

  const openHome = async (): Promise<void> => {
    if (openingHomeRef.current) {
      return
    }
    openingHomeRef.current = true
    setOpeningHome(true)
    try {
      await openHomeFolderProject()
    } finally {
      openingHomeRef.current = false
      if (mountedRef.current) {
        setOpeningHome(false)
      }
    }
  }

  return (
    <div
      className="flex w-full max-w-[420px] flex-col items-center gap-4 py-8 text-center"
      data-landing-first-run-welcome
    >
      <LandingLogoTile />
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {t('components.landing.firstRun.title', 'Start with a project')}
      </h1>
      <p className="text-sm text-muted-foreground">
        {t(
          'components.landing.firstRun.body',
          'Orca runs your coding agents in workspaces, each on its own branch. Add a repository to begin.'
        )}
      </p>
      {notice}
      <div className="flex flex-col items-center gap-3">
        <Button onClick={() => openModal('add-repo')}>
          <FolderPlus className="size-3.5" />
          {t('auto.components.Landing.f9eaa9e12d', 'Add project')}
        </Button>
        <button
          type="button"
          className="cursor-pointer text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:cursor-default disabled:opacity-60"
          onClick={() => void openHome()}
          disabled={openingHome}
        >
          {t(
            'components.landing.firstRun.openHomeTerminal',
            'Or open a terminal in your home folder'
          )}
        </button>
      </div>
    </div>
  )
}
