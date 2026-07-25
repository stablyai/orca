import { useState, useMemo } from 'react'
import type React from 'react'
import { Bot, Brain, Terminal, Search, XCircle, SlidersHorizontal, FileJson } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { NativeChatMessageList } from '../native-chat/NativeChatMessageList'
import type { NativeChatLiveSession } from '../native-chat/use-native-chat-live-session'
import { parseSubagentJsonlTranscript } from './subagent-transcript-parser'
import { convertSubagentStepsToNativeChatMessages } from './subagent-transcript-native-chat-messages'

/**
 * Header shown above the raw JSONL editor. Why: raw mode replaces the whole
 * transcript surface, including its toolbar, so without this the only way back
 * would be closing and reopening the tab.
 */
export function SubagentRawTranscriptBar({
  filePath,
  onToggleRawMode
}: {
  filePath: string
  onToggleRawMode: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-sidebar/50 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <FileJson className="size-3" />
          <span>Raw JSONL</span>
        </Badge>
        <span className="truncate text-[11px] text-muted-foreground" title={filePath}>
          {subagentTranscriptFileName(filePath)}
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onToggleRawMode}
        className="h-7 gap-1 border-border/80 px-2 text-[11px]"
        title="Back to the subagent transcript view"
      >
        <Bot className="size-3.5" />
        <span>Transcript</span>
      </Button>
    </div>
  )
}

function subagentTranscriptFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || 'subagent-log.jsonl'
}

type SubagentTranscriptViewerProps = {
  content: string
  filePath: string
  onToggleRawMode?: () => void
}

export function SubagentTranscriptViewer({
  content,
  filePath,
  onToggleRawMode
}: SubagentTranscriptViewerProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('')
  const [showThinking, setShowThinking] = useState(false)
  const [showToolCalls, setShowToolCalls] = useState(true)
  const [errorsOnly, setErrorsOnly] = useState(false)

  const steps = useMemo(() => parseSubagentJsonlTranscript(content), [content])

  const filteredSteps = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return steps.filter((step) => {
      if (errorsOnly && step.status !== 'error') {
        return false
      }
      if (!showThinking && step.type === 'THINKING') {
        return false
      }
      if (!showToolCalls && step.type === 'TOOL_CALL') {
        return false
      }

      if (query) {
        return step.searchCorpus ? step.searchCorpus.includes(query) : false
      }

      return true
    })
  }, [steps, errorsOnly, showThinking, showToolCalls, searchQuery])

  const nativeChatMessages = useMemo(
    () => convertSubagentStepsToNativeChatMessages(filteredSteps),
    [filteredSteps]
  )

  const liveSession = useMemo<NativeChatLiveSession>(
    () => ({
      messages: nativeChatMessages,
      status: 'ready',
      // Why: a transcript file is a finished recording, not a live provider
      // session — there is no conversation to resume and nothing to page in.
      sessionId: null,
      agent: 'claude',
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: () => {}
    }),
    [nativeChatMessages]
  )

  // Why: a live-tailed transcript ends mid-step while the agent is still running,
  // so the trailing step drives the working indicator.
  const isWorking = useMemo(() => {
    const lastStep = steps.at(-1)
    if (!lastStep) {
      return false
    }
    return lastStep.type === 'THINKING' || (lastStep.type === 'TOOL_CALL' && !lastStep.toolResult)
  }, [steps])

  const fileName = subagentTranscriptFileName(filePath)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground font-sans">
      {/* Top Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-sidebar/50 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="outline" className="gap-1 border-primary/40 bg-primary/10 text-primary">
            <Bot className="size-3" />
            <span>Subagent Transcript</span>
          </Badge>
          <span className="truncate text-muted-foreground text-[11px]" title={filePath}>
            {fileName}
          </span>
          <span className="text-[10px] text-muted-foreground/70">({steps.length} steps)</span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Search Input */}
          <div className="relative w-40 sm:w-48">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search log..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 pl-7 text-xs bg-background/80"
            />
          </div>

          {/* Quick Filters */}
          <Button
            type="button"
            variant={showThinking ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setShowThinking(!showThinking)}
            className="h-7 px-2 text-[11px] gap-1"
            title="Toggle Thinking Steps"
          >
            <Brain className="size-3" />
            <span>Thinking</span>
          </Button>

          <Button
            type="button"
            variant={showToolCalls ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setShowToolCalls(!showToolCalls)}
            className="h-7 px-2 text-[11px] gap-1"
            title="Toggle Tool Calls"
          >
            <Terminal className="size-3" />
            <span>Tools</span>
          </Button>

          <Button
            type="button"
            variant={errorsOnly ? 'destructive' : 'ghost'}
            size="sm"
            onClick={() => setErrorsOnly(!errorsOnly)}
            className="h-7 px-2 text-[11px] gap-1"
            title="Show Errors Only"
          >
            <XCircle className="size-3" />
            <span>Errors</span>
          </Button>

          {/* Raw View Toggle */}
          {onToggleRawMode ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onToggleRawMode}
              className="h-7 px-2 text-[11px] gap-1 border-border/80"
              title="Switch to Raw JSONL Monaco Editor"
            >
              <FileJson className="size-3.5" />
              <span>Raw JSONL</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Read-only NativeChat List Feed */}
      <div className="min-h-0 flex-1 relative">
        {filteredSteps.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-muted-foreground text-xs gap-1.5 pt-8">
            <SlidersHorizontal className="size-5 opacity-50" />
            <span>No transcript steps match your current filters.</span>
          </div>
        ) : (
          <NativeChatMessageList
            session={liveSession}
            isWorking={isWorking}
            expandSignal={false}
            fontScale={1}
            allowFileUriLinks={true}
          />
        )}
      </div>
    </div>
  )
}
