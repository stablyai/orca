import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { requestNativeChatComposerFocus } from '../native-chat/use-native-chat-composer-reveal-focus'
import type { AddRepoDialogHostedController } from '../sidebar/use-add-repo-hosted-controller'
import { eligibleThreadProjects } from './thread-projects'
import { useThreadNavigation } from './thread-navigation'

/** The requesting chooser receives the project; global Add Project keeps its checkout continuation. */
export function useThreadProjectAddController(): AddRepoDialogHostedController | undefined {
  const activeModal = useAppStore((s) => s.activeModal)
  const context = useThreadNavigation((s) => s.projectRequest)
  if (!context) {
    return undefined
  }
  const current = () => {
    const state = useThreadNavigation.getState()
    const original = context.selection
    const selected = state.selection
    return (
      state.request === context.request &&
      (original?.kind === 'new'
        ? selected?.kind === 'new' &&
          selected.draftId === original.draftId &&
          selected.projectKey === original.projectKey
        : selected === original)
    )
  }
  return {
    open: activeModal === 'add-repo',
    onOpenChange: (open) => {
      if (!open) {
        useThreadNavigation.setState({ projectRequest: null })
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
      if (!project) {
        return
      }
      const selection = useThreadNavigation.getState().selection
      useAppStore.getState().setActiveView('terminal')
      useThreadNavigation.setState({
        selection:
          selection?.kind === 'new'
            ? { ...selection, projectKey: project.key }
            : { kind: 'new', projectKey: project.key, draftId: createBrowserUuid() }
      })
    },
    onCloseAutoFocus: (event) => {
      event.preventDefault()
      const state = useThreadNavigation.getState()
      if (
        state.request === context.request &&
        state.selection?.kind === 'new' &&
        (context.selection?.kind !== 'new' || state.selection.draftId === context.selection.draftId)
      ) {
        requestNativeChatComposerFocus(`thread-draft:${state.selection.draftId}`)
      }
    }
  }
}
