import { useCallback, useState } from 'react'
import { ArrowUpRight, Loader2, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { FeatureSetupInlineTerminal } from '../onboarding/FeatureSetupInlineTerminal'
import {
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupSelection
} from '../onboarding/onboarding-feature-setup'
import {
  promptForSetupGuideProject,
  useSetupTargetWorktree
} from './FeatureWallSetupWorkflowActions'

export function BrowserAction(props: { done: boolean }): React.JSX.Element {
  const targetWorktree = useSetupTargetWorktree()
  const openModal = useAppStore((s) => s.openModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const openNewBrowserTabInActiveWorkspace = useAppStore(
    (s) => s.openNewBrowserTabInActiveWorkspace
  )

  const handleTryIt = useCallback(() => {
    if (!targetWorktree) {
      promptForSetupGuideProject(openModal)
      return
    }
    closeModal()
    activateAndRevealWorktree(targetWorktree.id)
    const state = useAppStore.getState()
    // Why: open the browser into the worktree's active group so it lands beside
    // the user's current work rather than spawning a detached surface.
    const groupId =
      state.activeGroupIdByWorktree[targetWorktree.id] ??
      state.groupsByWorktree[targetWorktree.id]?.[0]?.id
    if (groupId) {
      void openNewBrowserTabInActiveWorkspace(groupId)
    } else {
      toast.warning('Browser could not open', {
        description: 'No workspace group is available for this worktree yet.'
      })
    }
  }, [closeModal, openModal, openNewBrowserTabInActiveWorkspace, targetWorktree])

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {props.done ? null : (
        <Button type="button" size="sm" className="w-fit gap-2" onClick={handleTryIt}>
          <ArrowUpRight className="size-3.5" />
          Try it out
        </Button>
      )}
      <BrowserSkillInstallButton />
    </div>
  )
}

// Scope the shared feature setup to just browser use — the grab→agent flow only
// needs the Orca CLI and browser skill, not Computer Use or orchestration.
const BROWSER_ONLY_FEATURE_SETUP: OnboardingFeatureSetupSelection = {
  browserUse: true,
  computerUse: false,
  orchestration: false
}

// The grab→agent flow relies on the Orca CLI and browser skill, so offer the same
// install action the Enable Orca CLI step uses, scoped to just browser use.
function BrowserSkillInstallButton(): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [command, setCommand] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleInstall = useCallback(async () => {
    if (busy || command !== null) {
      return
    }
    setBusy(true)
    try {
      const result = await runOnboardingFeatureSetup(BROWSER_ONLY_FEATURE_SETUP)
      recordFeatureInteraction('agent-browser-setup')
      const firstWarning = result.warnings[0]
      if (firstWarning) {
        toast.warning('Browser setup needs attention', { description: firstWarning.message })
      } else if (result.skillCommandsCopied) {
        toast.success('Browser setup ready', {
          description: 'Skill command copied and inserted below for review.'
        })
      }
      if (result.skillInstallCommand) {
        setCommand(result.skillInstallCommand)
      }
    } catch (error) {
      console.error('Browser setup failed', error)
      toast.error('Browser setup failed', {
        description: error instanceof Error ? error.message : 'An unexpected error occurred.'
      })
    } finally {
      setBusy(false)
    }
  }, [busy, command, recordFeatureInteraction])

  if (command) {
    return <FeatureSetupInlineTerminal command={command} selection={BROWSER_ONLY_FEATURE_SETUP} />
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="w-fit gap-2"
      disabled={busy}
      onClick={() => void handleInstall()}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Terminal className="size-3.5" />}
      {busy ? 'Installing…' : 'Install CLI & Skill'}
    </Button>
  )
}
