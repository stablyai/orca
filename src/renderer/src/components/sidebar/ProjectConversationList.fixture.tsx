import { defineFixture } from '../../component-fixtures/component-fixture'
import { ProjectConversationList } from './ProjectConversationList'
import SidebarHeader from './chrome/SidebarHeader'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import {
  conversationListProps,
  conversationStore,
  conversationSessions
} from './ProjectConversationList.test-fixture'
import { getDefaultSettings, getDefaultUIState } from '../../../../shared/orca-profiles/constants'
import { refreshLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import type { ConversationPreferences } from '../../../../shared/conversation-navigation-preferences'
import { updateConversationPreference } from '../../../../shared/conversation-navigation-preferences'

const discovered = {
  ...conversationSessions[0]!,
  id: 'discovered',
  sessionId: 'discovered',
  cwd: '/notes',
  title: 'Outline release notes',
  agent: 'gemini' as const
}
const discoveredKey = JSON.stringify(['local', 'folder:/notes'])

function fixture(
  width = 320,
  state: 'default' | 'discovered' | 'hidden' | 'registered' | 'loading' = 'default'
) {
  const props = conversationListProps()
  if (state === 'loading') {
    props.groups = []
    props.loading = true
    props.sessionsCount = 0
    props.filteredSessionsCount = 0
  }
  if (state === 'discovered' || state === 'hidden') {
    props.groups = [...props.groups, { key: 'notes', label: 'Notes', sessions: [discovered] }]
    props.sessionProjects = new Map([
      ...(props.sessionProjects ?? []),
      [discovered.id, { kind: 'folder' as const, key: 'folder:/notes', label: 'Notes' }]
    ])
  }
  return defineFixture({
    width,
    store: {
      ...conversationStore,
      // English, so the interactions below find their menus by label.
      settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' },
      sidebarView: 'conversations',
      sidebarBody: 'conversations'
    },
    setup: () => {
      let preferences: ConversationPreferences = {
        revision: 0,
        entries: {},
        ...(state === 'hidden' ? { hiddenProjects: { [discoveredKey]: 'Notes' } } : {})
      }
      window.api.runtime.getStatus = async () => ({
        runtimeId: 'fixture',
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2,
        capabilities: ['ui.conversationPreferences.v1', 'ui.conversationProjectVisibility.v1']
      })
      window.api.runtime.call = async (request) => {
        let result: unknown = {
          ui: { ...getDefaultUIState(), conversationPreferences: preferences }
        }
        if (request.method === 'ui.setConversationPreference') {
          const parsed = (
            await import('../../../../shared/conversation-navigation-preferences')
          ).SetConversationPreferenceParams.parse(request.params)
          preferences = updateConversationPreference(preferences, parsed)
          result = { preferences }
        }
        return { id: 'fixture', ok: true, result, _meta: { runtimeId: 'fixture' } }
      }
      void refreshLocalRuntimeCapabilities()
    },
    interact:
      state === 'registered'
        ? async (frame) => {
            const trigger = frame.querySelector<HTMLButtonElement>(
              'button[aria-label="Project actions for Acme"]'
            )
            trigger?.focus()
            trigger?.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
            )
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
          }
        : state === 'discovered'
          ? async (frame) => {
              const trigger = frame.querySelector<HTMLButtonElement>(
                'button[aria-label="Project options for Notes"]'
              )
              trigger?.focus()
              trigger?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
              )
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
              )
            }
          : state === 'hidden'
            ? async (frame) => {
                const trigger = Array.from(frame.querySelectorAll('button')).find((button) =>
                  button.textContent?.includes('Hidden projects')
                )
                trigger?.focus()
                trigger?.dispatchEvent(
                  new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
                )
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
                )
              }
            : undefined,
    render: () => (
      <ConfirmationDialogProvider>
        <div className="flex h-128 flex-col bg-worktree-sidebar text-worktree-sidebar-foreground">
          <SidebarHeader onWorkspaceBoardMenuOpenChange={() => {}} />
          <ProjectConversationList {...props} />
        </div>
      </ConfirmationDialogProvider>
    )
  })
}
export const compactProjects = fixture()
export const narrowProjects = fixture(260)

export const discoveredProjectActions = fixture(320, 'discovered')
export const hiddenProjectRestore = fixture(320, 'hidden')

export const registeredProjectActions = fixture(320, 'registered')

export const loadingProjects = fixture(320, 'loading')
