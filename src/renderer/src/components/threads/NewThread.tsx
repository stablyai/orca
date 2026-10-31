import { useCallback, useMemo, useRef, useState } from 'react'
import { useNativeChatComposerRevealFocus } from '../native-chat/use-native-chat-composer-reveal-focus'
import { Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { translate } from '@/i18n/i18n'
import {
  NativeChatComposer,
  type NativeChatComposerHandle
} from '../native-chat/NativeChatComposer'
import type { NativeChatStructuredComposerTransport } from '../native-chat/native-chat-composer-types'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from '../native-chat/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '../native-chat/use-native-chat-store-appearance-style'
import { RepoIconGlyph } from '../repo/repo-icon'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
  CommandGroup,
  CommandSeparator
} from '../ui/command'
import { useThreadProjects } from './use-thread-projects'
import {
  changeThreadDraftProject,
  requestThreadProjectAdd,
  threadDraftScopeKey
} from './thread-navigation'
import { sendNewThread } from './thread-actions'
import { useThreadLaunchChoices } from './use-thread-launch-choices'

export function NewThread({
  projectKey,
  draftId
}: {
  projectKey: string
  draftId: string
}): React.JSX.Element {
  const { projects, loading } = useThreadProjects()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sent = useRef(false)
  const composer = useRef<NativeChatComposerHandle>(null)
  const root = useRef<HTMLDivElement>(null)
  const modalOpen = useAppStore((s) => s.activeModal !== 'none')
  const [sending, setSending] = useState(false)
  const project = projects.find((item) => item.key === projectKey) ?? projects[0]
  const focusComposer = useCallback(() => composer.current?.focus(), [])
  const choices = useThreadLaunchChoices(project, focusComposer, draftId)
  const chosenAgent = choices.agent
  const appearance = useNativeChatStoreAppearanceStyle()
  useNativeChatComposerRevealFocus({
    tabId: threadDraftScopeKey(),
    rootRef: root,
    composerRef: composer,
    isVisible: !pickerOpen && !modalOpen,
    isFocusedGroup: true,
    composerReady: !loading && !!project && !sending
  })
  const transport = useMemo(
    (): NativeChatStructuredComposerTransport => ({
      capturePresentation: () => () => true,
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      send: (text) => {
        if (!project || loading || sent.current) {
          return false
        }
        setError(null)
        sent.current = true
        setSending(true)
        try {
          const launch = sendNewThread(project, text, {
            agent: choices.agent,
            launchOptions: choices.launchInputs.sessionOptions
          })
          if (!launch) {
            sent.current = false
            setSending(false)
            return false
          }
          void launch.settlement.then(() => {
            sent.current = false
            setSending(false)
          })
          return true
        } catch {
          sent.current = false
          setSending(false)
          setError(
            translate(
              'threads.createFailed',
              '{{agent}} could not start this chat. Try sending again.',
              { agent: structuredAgentLabel(chosenAgent) }
            )
          )
          return false
        }
      },
      launchPicker: choices.picker,
      optionsSurface: choices.surface,
      optionSnapshot: choices.snapshot,
      acceptsImages: false,
      onError: setError,
      runtime: project?.hostId === 'local' ? 'local' : 'remote',
      sessionId: draftId,
      runtimeEnvironmentId: project?.hostId.startsWith('runtime:') ? project.hostId.slice(8) : null,
      worktreeId: project?.worktree.id
    }),
    [project, loading, draftId, chosenAgent, choices]
  )
  const repos = useAppStore((s) => s.repos)
  const selectedName = useMemo(
    () =>
      repos.find(
        (repo) =>
          projectKey ===
          `${repo.executionHostId ?? (repo.connectionId ? `ssh:${repo.connectionId}` : 'local')}|${repo.id}`
      )?.displayName ?? '',
    [repos, projectKey]
  )
  const title = project?.repo.displayName ?? selectedName
  return (
    <div
      ref={root}
      data-native-chat-root="true"
      data-native-chat-scheme={appearance.colorScheme}
      className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} flex min-h-0 flex-1 items-center justify-center bg-chat-canvas px-6`}
      style={appearance}
    >
      <div className="w-full max-w-3xl space-y-6">
        <h1 className="text-center text-2xl font-normal text-chat-foreground-strong">
          {translate('threads.headline', 'What should we build in')}{' '}
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={loading}
                className="max-w-full truncate border-b border-dotted border-current font-medium disabled:opacity-50"
                aria-label={translate('threads.chooseProject', 'Choose project')}
              >
                {title}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="center">
              <Command>
                <CommandInput
                  placeholder={translate('threads.searchProjects', 'Search projects...')}
                />
                <CommandList>
                  <CommandEmpty>
                    {translate('threads.noProjectsFound', 'No projects found.')}
                  </CommandEmpty>
                  <CommandGroup>
                    {projects.map((item) => (
                      <CommandItem
                        key={item.key}
                        value={`${item.repo.displayName} ${item.key}`}
                        onSelect={() => {
                          changeThreadDraftProject(draftId, item.key)
                          setPickerOpen(false)
                        }}
                      >
                        <RepoIconGlyph repoIcon={item.repo.repoIcon} className="size-4" />
                        {item.repo.displayName}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => {
                        setPickerOpen(false)
                        requestThreadProjectAdd()
                        useAppStore.getState().openModal('add-repo')
                      }}
                    >
                      <Plus className="size-4" />
                      {translate('threads.addProject', 'Add project')}
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          ?
        </h1>
        <NativeChatComposer
          ref={composer}
          terminalTabId={threadDraftScopeKey()}
          paneKey={`${threadDraftScopeKey()}:composer`}
          draftScopeKey={threadDraftScopeKey()}
          targetPtyId={null}
          agent={chosenAgent}
          structuredTransport={transport}
          workspacePending
          canSend={!loading && !!project && !sending}
          placeholder={translate(
            'threads.placeholder',
            'Ask for changes, or ask anything about this project'
          )}
          notices={error ? [{ key: 'thread-create', kind: 'error', text: error }] : []}
        />
      </div>
    </div>
  )
}
