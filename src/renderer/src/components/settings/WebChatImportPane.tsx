import type React from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  WEB_CHAT_AGENTS,
  aiVaultAgentLabel,
  type WebChatAgent
} from '../../../../shared/ai-vault-types'
import { resolveWebChatCwdByAgent } from '../../../../shared/web-chat-location'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'

type WebChatImportPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function WebChatImportPane({
  settings,
  updateSettings
}: WebChatImportPaneProps): React.JSX.Element {
  // Why: shows each agent's resolved default (workspaceDir/<source>) as the
  // input placeholder so an empty override reads as "falls back to this".
  const defaultDirByAgent = resolveWebChatCwdByAgent({}, settings.workspaceDir)

  return (
    <SearchableSetting
      title={translate('auto.components.settings.WebChatImportPane.paneTitle', 'Web Chat Import')}
      description={translate(
        'auto.components.settings.WebChatImportPane.paneDescription',
        'Choose the folder each web agent imports conversations from. Leave a field empty to use the default folder inside your workspace directory.'
      )}
      keywords={[
        'web chat',
        'chatgpt',
        'claude.ai',
        'gemini',
        'import',
        'directory',
        'folder',
        'ai vault',
        'transcripts'
      ]}
      className="space-y-3"
    >
      {WEB_CHAT_AGENTS.map((agent) => (
        <WebChatAgentDirectoryRow
          key={agent}
          agent={agent}
          value={settings.webChatDirByAgent?.[agent] ?? ''}
          placeholder={defaultDirByAgent[agent]}
          webChatDirByAgent={settings.webChatDirByAgent}
          updateSettings={updateSettings}
        />
      ))}
    </SearchableSetting>
  )
}

type WebChatAgentDirectoryRowProps = {
  agent: WebChatAgent
  value: string
  placeholder: string
  webChatDirByAgent: Partial<Record<WebChatAgent, string>> | undefined
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function WebChatAgentDirectoryRow({
  agent,
  value,
  placeholder,
  webChatDirByAgent,
  updateSettings
}: WebChatAgentDirectoryRowProps): React.JSX.Element {
  const inputId = useId()
  // Why: settings:set persists on commit, not per keystroke; drafting locally
  // avoids writing on every character while typing a path.
  const [draftValue, setDraftValue] = useState(value)
  const draftValueRef = useRef(value)
  const skipNextBlurCommitRef = useRef(false)

  useEffect(() => {
    setDraftValue(value)
    draftValueRef.current = value
  }, [value])

  const setDraft = (next: string): void => {
    draftValueRef.current = next
    setDraftValue(next)
  }

  const writeValue = (next: string): void => {
    const nextByAgent: Partial<Record<WebChatAgent, string>> = { ...webChatDirByAgent }
    // Why: an empty override falls back to workspaceDir/<source> in resolveWebChatCwdByAgent.
    if (next.trim()) {
      nextByAgent[agent] = next
    } else {
      delete nextByAgent[agent]
    }
    updateSettings({ webChatDirByAgent: nextByAgent })
  }

  const commitDraftValue = (): void => {
    const next = draftValueRef.current
    if (next === value) {
      return
    }
    writeValue(next)
  }

  const handleBlur = (): void => {
    if (skipNextBlurCommitRef.current) {
      skipNextBlurCommitRef.current = false
      return
    }
    commitDraftValue()
  }

  const resetDraftValue = (): void => {
    setDraft(value)
  }

  const handleBrowse = async (): Promise<void> => {
    try {
      const path = await window.api.repos.pickFolder()
      if (path) {
        setDraft(path)
        writeValue(path)
        return
      }
      resetDraftValue()
    } finally {
      skipNextBlurCommitRef.current = false
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId} className="text-xs text-muted-foreground">
        {aiVaultAgentLabel(agent)}
      </Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={draftValue}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            // Why: an Enter that only confirms a CJK IME candidate must not
            // commit the value; wait for a non-composition Enter.
            if (isImeCompositionKeyDown(e)) {
              return
            }
            if (e.key === 'Enter') {
              skipNextBlurCommitRef.current = true
              commitDraftValue()
              e.currentTarget.blur()
              return
            }
            if (e.key === 'Escape') {
              skipNextBlurCommitRef.current = true
              resetDraftValue()
              e.currentTarget.blur()
            }
          }}
          className="flex-1 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          onPointerDown={() => {
            skipNextBlurCommitRef.current = true
          }}
          onClick={() => void handleBrowse()}
          className="shrink-0 gap-1.5"
        >
          <FolderOpen className="size-3.5" />
          {translate('auto.components.settings.WebChatImportPane.browseButton', 'Browse')}
        </Button>
      </div>
    </div>
  )
}
