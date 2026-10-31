import { useAppStore } from '@/store'
import { canPresentDesktopNavigation, commitDesktopNavigation } from '@/lib/desktop-navigation'
import { requestNativeChatComposerFocus } from '../native-chat/use-native-chat-composer-reveal-focus'
import type { AddRepoDialogHostedController } from '../sidebar/use-add-repo-hosted-controller'
import { eligibleThreadProjects } from './thread-projects'
import { useThreadDraft, enterThreadDraft, threadDraftScopeKey } from './thread-navigation'

/** Contextual Git completion edits the same content; folder completion remains workspace navigation. */
export function useThreadProjectAddController(): AddRepoDialogHostedController | undefined {
  const activeModal = useAppStore((s) => s.activeModal)
  const context = useThreadDraft((s) => s.projectRequest)
  if (!context) {
    return undefined
  }
  const current = () =>
    canPresentDesktopNavigation(context.request) &&
    (context.draftId === null || useThreadDraft.getState().draft?.draftId === context.draftId)
  return {
    navigation: context.request,
    open: activeModal === 'add-repo',
    onOpenChange: (open) => {
      if (!open) {
        useThreadDraft.setState({ projectRequest: null })
        useAppStore.getState().closeModal()
      }
    },
    onProjectGroupImported: () => true,
    onProjectAdded: async (repoId, hostId = 'local') => {
      const projects = await eligibleThreadProjects(useAppStore.getState())
      if (!current()) {
        return
      }
      const project = projects.find((p) => p.repo.id === repoId && p.hostId === hostId)
      if (project) {
        commitDesktopNavigation(context.request, () =>
          enterThreadDraft(project.key, context.request)
        )
      }
    },
    onCloseAutoFocus: (event) => {
      event.preventDefault()
      if (current() && useAppStore.getState().activeView === 'thread-draft') {
        requestNativeChatComposerFocus(threadDraftScopeKey())
      }
    }
  }
}
