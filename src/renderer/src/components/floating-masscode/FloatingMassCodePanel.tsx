/* eslint-disable max-lines -- Why: this experimental bridge owns snippet list, view, and edit modes in one state machine so vault refresh and mode transitions stay local. */
import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import hljs from 'highlight.js/lib/common'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Search,
  X,
  Plus,
  Folder,
  ArrowLeft,
  Save,
  ChevronRight,
  Inbox,
  Star,
  Trash2,
  Copy,
  Check,
  Code,
  FileText,
  Globe,
  Edit2,
  List,
  Calculator,
  Wrench,
  Maximize2,
  Minimize2
} from 'lucide-react'
import {
  fetchMassCodeData,
  getMassCodeSnippetFilePath,
  normalizeMassCodePathForMatch,
  normalizeMassCodePreviewLines,
  writeMassCodeSnippet,
  type MassCodeData,
  type MassCodeExtendedSnippet,
  type MassCodeType
} from '@/lib/masscode-manager'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  clampFloatingMassCodeBounds,
  getDefaultFloatingMassCodeBounds,
  getMaximizedFloatingMassCodeBounds,
  type FloatingMassCodePanelBounds
} from './floating-masscode-panel-bounds'

type NavCategory = 'all' | 'inbox' | 'favorites' | 'trash' | 'folder'

const floatingMassCodeSurfaceClassName =
  'fixed z-50 flex min-h-[280px] min-w-[320px] flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]'
const floatingMassCodeHeaderClassName =
  'flex h-9 shrink-0 items-center justify-between border-b border-border bg-[var(--bg-titlebar,var(--card))]'
const floatingMassCodeControlButtonClassName =
  'border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground'
const MASSCODE_HIGHLIGHT_CHAR_LIMIT = 80_000

type MassCodeLanguageOption = { value: string; label: string }

const MASSCODE_BASE_LANGUAGE_OPTIONS: MassCodeLanguageOption[] = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'plaintext', label: 'Plain Text' }
]

function toLanguageLabel(languageId: string): string {
  const normalized = languageId.trim()
  const upperCaseLabels: Record<string, string> = {
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    css: 'CSS',
    html: 'HTML',
    java: 'Java',
    javascript: 'JavaScript',
    json: 'JSON',
    jsx: 'JSX',
    lua: 'Lua',
    markdown: 'Markdown',
    php: 'PHP',
    python: 'Python',
    r: 'R',
    ruby: 'Ruby',
    rust: 'Rust',
    scala: 'Scala',
    shell: 'Shell',
    sql: 'SQL',
    swift: 'Swift',
    toml: 'TOML',
    tsx: 'TSX',
    typescript: 'TypeScript',
    xml: 'XML',
    yaml: 'YAML'
  }

  if (upperCaseLabels[normalized]) {
    return upperCaseLabels[normalized]
  }

  const withSpaces = normalized.replace(/[-_]+/g, ' ')
  return withSpaces
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function buildMassCodeLanguageOptions(): MassCodeLanguageOption[] {
  const map = new Map<string, string>()

  for (const option of MASSCODE_BASE_LANGUAGE_OPTIONS) {
    map.set(option.value, option.label)
  }

  for (const languageId of hljs.listLanguages()) {
    if (!map.has(languageId)) {
      map.set(languageId, toLanguageLabel(languageId))
    }
  }

  return Array.from(map.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

const MASSCODE_LANGUAGE_OPTIONS = buildMassCodeLanguageOptions()

export function FloatingMassCodePanel({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}): React.JSX.Element | null {
  const vaultPath = useAppStore((s) => s.settings?.experimentalMassCodeVaultPath)
  const previewLines = useAppStore((s) =>
    normalizeMassCodePreviewLines(s.settings?.experimentalMassCodePreviewLines)
  )
  const theme = useAppStore((s) => s.settings?.theme ?? 'system')
  const [data, setData] = useState<MassCodeData | null>(null)
  const [search, setSearch] = useState('')
  const [selectedType, setSelectedType] = useState<MassCodeType>(1)
  const [selectedNav, setSelectedNav] = useState<NavCategory>('all')
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [bounds, setBounds] = useState<FloatingMassCodePanelBounds>(() =>
    getDefaultFloatingMassCodeBounds()
  )
  const [maximized, setMaximized] = useState(false)
  const [editingSnippet, setEditingSnippet] = useState<Partial<MassCodeExtendedSnippet> | null>(
    null
  )
  const [viewingSnippet, setViewingSnippet] = useState<MassCodeExtendedSnippet | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const codeRef = useRef<HTMLElement>(null)
  const restoreBoundsRef = useRef<FloatingMassCodePanelBounds | null>(null)
  const refreshRequestIdRef = useRef(0)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startBounds: FloatingMassCodePanelBounds
    nextBounds: FloatingMassCodePanelBounds
    frame: number | null
  } | null>(null)

  const refreshData = useCallback(() => {
    if (!vaultPath) {
      setData(null)
      return
    }
    const requestId = refreshRequestIdRef.current + 1
    refreshRequestIdRef.current = requestId
    setLoading(true)
    setLoadError(null)
    void fetchMassCodeData(vaultPath)
      .then((nextData) => {
        if (refreshRequestIdRef.current === requestId) {
          setData(nextData)
        }
      })
      .catch((error: unknown) => {
        if (refreshRequestIdRef.current === requestId) {
          setData(null)
          setLoadError(error instanceof Error ? error.message : 'Failed to load massCode vault')
        }
      })
      .finally(() => {
        if (refreshRequestIdRef.current === requestId) {
          setLoading(false)
        }
      })
  }, [vaultPath])

  useEffect(() => {
    if (open) {
      refreshData()
      if (!maximized) {
        setBounds(getDefaultFloatingMassCodeBounds())
      }
    }
  }, [maximized, open, refreshData])

  useEffect(() => {
    if (!open || typeof window === 'undefined') {
      return
    }
    const handleResize = () => {
      if (maximized) {
        setBounds(getMaximizedFloatingMassCodeBounds())
        return
      }
      setBounds((prev) => clampFloatingMassCodeBounds(prev))
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [maximized, open])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
      if (dragStateRef.current?.frame !== null && dragStateRef.current?.frame !== undefined) {
        window.cancelAnimationFrame(dragStateRef.current.frame)
      }
    }
  }, [])

  useEffect(() => {
    if (!viewingSnippet || !codeRef.current) {
      return
    }
    const language = viewingSnippet.language?.trim().toLowerCase() ?? ''
    codeRef.current.className = language ? `language-${language}` : ''
    codeRef.current.removeAttribute('data-highlighted')
    if (viewingSnippet.content.length <= MASSCODE_HIGHLIGHT_CHAR_LIMIT) {
      hljs.highlightElement(codeRef.current)
    }
  }, [viewingSnippet])

  const filteredSnippets = useMemo(() => {
    if (!data) {
      return []
    }
    return data.snippets.filter((s) => {
      const mSearch =
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.content.toLowerCase().includes(search.toLowerCase())
      if (!mSearch || s.type !== selectedType) {
        return false
      }
      if (selectedNav === 'inbox') {
        return s.inInbox && !s.isTrash
      }
      if (selectedNav === 'favorites') {
        return s.isFavorite && !s.isTrash
      }
      if (selectedNav === 'trash') {
        return s.isTrash
      }
      if (selectedNav === 'folder' && selectedFolderId) {
        return s.folderId === selectedFolderId && !s.isTrash
      }
      return !s.isTrash
    })
  }, [data, search, selectedType, selectedNav, selectedFolderId])

  const visibleFolders = useMemo(() => {
    if (!data) {
      return []
    }
    const typePaths: Record<number, string> = {
      1: '/code/',
      2: '/notes/',
      3: '/http/',
      4: '/math/',
      5: '/tools/'
    }
    const pathPart = typePaths[selectedType]
    if (!pathPart) {
      return []
    }
    return data.folders.filter((f) => normalizeMassCodePathForMatch(f.id).includes(pathPart))
  }, [data, selectedType])

  const handleCopy = (s: MassCodeExtendedSnippet) => {
    // Why: Electron renderers can reject navigator.clipboard writes depending
    // on focus/permission state; Orca's clipboard IPC is the app-wide path.
    void window.api.ui
      .writeClipboardText(s.content)
      .then(() => {
        setCopiedId(s.id)
        toast.success(`Copied "${s.name}"`)
        if (copyResetTimeoutRef.current !== null) {
          window.clearTimeout(copyResetTimeoutRef.current)
        }
        copyResetTimeoutRef.current = window.setTimeout(() => setCopiedId(null), 2000)
      })
      .catch(() => toast.error('Failed to copy snippet'))
  }

  const handleSave = async () => {
    if (!editingSnippet || !vaultPath) {
      return
    }
    try {
      const filePath =
        editingSnippet.id ||
        getMassCodeSnippetFilePath({
          vaultPath,
          selectedFolderId,
          selectedType,
          snippetName: editingSnippet.name
        })
      await writeMassCodeSnippet(filePath, editingSnippet)
      toast.success('Snippet saved')
      setEditingSnippet(null)
      refreshData()
    } catch (err) {
      toast.error('Failed to save snippet')
      console.error(err)
    }
  }

  const toggleMaximized = useCallback(() => {
    setMaximized((current) => {
      if (current) {
        setBounds(restoreBoundsRef.current ?? getDefaultFloatingMassCodeBounds())
        restoreBoundsRef.current = null
        return false
      }
      restoreBoundsRef.current = bounds
      setBounds(getMaximizedFloatingMassCodeBounds())
      return true
    })
  }, [bounds])

  const handleHeaderPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (maximized || event.button !== 0) {
        return
      }
      if (
        event.target instanceof Element &&
        event.target.closest('button,input,textarea,select,[role="button"]')
      ) {
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startBounds: bounds,
        nextBounds: bounds,
        frame: null
      }
    },
    [bounds, maximized]
  )

  const handleHeaderPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }
    dragState.nextBounds = {
      ...dragState.startBounds,
      left: dragState.startBounds.left + event.clientX - dragState.startX,
      top: dragState.startBounds.top + event.clientY - dragState.startY
    }
    if (dragState.frame !== null) {
      return
    }
    dragState.frame = window.requestAnimationFrame(() => {
      const latestDragState = dragStateRef.current
      if (!latestDragState) {
        return
      }
      setBounds(clampFloatingMassCodeBounds(latestDragState.nextBounds))
      latestDragState.frame = null
    })
  }, [])

  const handleHeaderPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const dragState = dragStateRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }
    if (dragState.frame !== null) {
      window.cancelAnimationFrame(dragState.frame)
    }
    setBounds(clampFloatingMassCodeBounds(dragState.nextBounds))
    dragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const resolvedThemeClass =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'markdown-dark'
        : 'markdown-light'
      : theme === 'dark'
        ? 'markdown-dark'
        : 'markdown-light'
  if (!open) {
    return null
  }

  const renderHeader = (
    title: string,
    onBack: () => void,
    actionIcon?: React.ReactNode,
    onAction?: () => void
  ) => (
    <div
      className={cn(
        floatingMassCodeHeaderClassName,
        !maximized && 'cursor-grab active:cursor-grabbing'
      )}
      onPointerDown={handleHeaderPointerDown}
      onPointerMove={handleHeaderPointerMove}
      onPointerUp={handleHeaderPointerEnd}
      onPointerCancel={handleHeaderPointerEnd}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
        <Button variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to snippets">
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="text-xs font-medium truncate max-w-[400px]">{title}</span>
      </div>
      <div className="flex items-center gap-1 px-2">
        <Button
          variant="outline"
          size="icon-xs"
          className={floatingMassCodeControlButtonClassName}
          onClick={toggleMaximized}
          aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
          aria-pressed={maximized}
        >
          {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
        {actionIcon && onAction ? (
          <Button
            variant="outline"
            size="icon-xs"
            className={floatingMassCodeControlButtonClassName}
            onClick={onAction}
          >
            {actionIcon}
          </Button>
        ) : (
          actionIcon
        )}
        <Button
          variant="outline"
          size="icon-xs"
          className={floatingMassCodeControlButtonClassName}
          onClick={() => onOpenChange(false)}
          aria-label="Close massCode snippets"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )

  if (viewingSnippet) {
    return (
      <div
        className={cn(floatingMassCodeSurfaceClassName, 'animate-in fade-in duration-200')}
        style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
      >
        {renderHeader(
          viewingSnippet.name,
          () => setViewingSnippet(null),
          <div className="flex gap-1">
            <Button variant="ghost" size="icon-xs" onClick={() => handleCopy(viewingSnippet)}>
              {copiedId === viewingSnippet.id ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                setEditingSnippet(viewingSnippet)
                setViewingSnippet(null)
              }}
            >
              <Edit2 className="size-3.5" />
            </Button>
          </div>
        )}
        <div className={cn('flex-1 p-0 overflow-hidden flex flex-col', resolvedThemeClass)}>
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-secondary/10 shrink-0">
            <span className="text-[10px] font-mono text-muted-foreground uppercase">
              {viewingSnippet.language}
            </span>
            {viewingSnippet.tags.map((t) => (
              <span
                key={t}
                className="text-[10px] bg-accent px-1.5 py-0.5 rounded text-accent-foreground"
              >
                {t}
              </span>
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-auto scrollbar-sleek px-3 py-2">
            <pre className="min-w-max text-[10px] leading-4 font-mono whitespace-pre text-foreground">
              <code ref={codeRef}>{viewingSnippet.content}</code>
            </pre>
          </div>
        </div>
      </div>
    )
  }

  if (editingSnippet) {
    return (
      <div
        className={floatingMassCodeSurfaceClassName}
        style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
      >
        {renderHeader(
          editingSnippet.id ? 'Edit Snippet' : 'New Snippet',
          () => setEditingSnippet(null),
          <Save className="size-3.5" />,
          () => void handleSave()
        )}
        <div className="flex-1 p-4 space-y-4 overflow-auto scrollbar-sleek flex flex-col">
          <div className="space-y-1.5 shrink-0">
            <label className="text-[10px] uppercase text-muted-foreground font-semibold">
              Title
            </label>
            <Input
              value={editingSnippet.name || ''}
              onChange={(e) => setEditingSnippet({ ...editingSnippet, name: e.target.value })}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1.5 shrink-0">
            <label className="text-[10px] uppercase text-muted-foreground font-semibold">
              Language
            </label>
            <Select
              value={editingSnippet.language || 'markdown'}
              onValueChange={(value) => setEditingSnippet({ ...editingSnippet, language: value })}
            >
              <SelectTrigger size="sm" className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MASSCODE_LANGUAGE_OPTIONS.map((languageOption) => (
                  <SelectItem key={languageOption.value} value={languageOption.value}>
                    {languageOption.label}
                  </SelectItem>
                ))}
                {editingSnippet.language &&
                !MASSCODE_LANGUAGE_OPTIONS.some(
                  (languageOption) => languageOption.value === editingSnippet.language
                ) ? (
                  <SelectItem value={editingSnippet.language}>{editingSnippet.language}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 flex flex-col flex-1 min-h-0">
            <label className="text-[10px] uppercase text-muted-foreground font-semibold">
              Content
            </label>
            <textarea
              value={editingSnippet.content || ''}
              onChange={(e) => setEditingSnippet({ ...editingSnippet, content: e.target.value })}
              className="flex-1 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(floatingMassCodeSurfaceClassName, 'animate-in fade-in duration-200')}
      style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
      data-floating-masscode-panel
    >
      <div className={floatingMassCodeHeaderClassName}>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          <Search className="size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search snippets..."
            className="h-7 border-none bg-transparent focus-visible:ring-0 text-sm p-0 shadow-none"
          />
        </div>
        <div className="flex items-center gap-1 px-2">
          <Button
            variant="outline"
            size="icon-xs"
            className={floatingMassCodeControlButtonClassName}
            onClick={toggleMaximized}
            aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
            aria-pressed={maximized}
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            className={floatingMassCodeControlButtonClassName}
            onClick={() => onOpenChange(false)}
            aria-label="Close massCode snippets"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-12 border-r border-border bg-secondary/20 flex flex-col items-center py-4 gap-4 shrink-0">
          <TypeIcon
            active={selectedType === 1}
            onClick={() => {
              setSelectedType(1)
              setSelectedNav('all')
            }}
            icon={<Code className="size-5" />}
            label="Code"
          />
          <TypeIcon
            active={selectedType === 2}
            onClick={() => {
              setSelectedType(2)
              setSelectedNav('all')
            }}
            icon={<FileText className="size-5" />}
            label="Notes"
          />
          <TypeIcon
            active={selectedType === 3}
            onClick={() => {
              setSelectedType(3)
              setSelectedNav('all')
            }}
            icon={<Globe className="size-5" />}
            label="HTTP"
          />
          <TypeIcon
            active={selectedType === 4}
            onClick={() => {
              setSelectedType(4)
              setSelectedNav('all')
            }}
            icon={<Calculator className="size-5" />}
            label="Math"
          />
          <TypeIcon
            active={selectedType === 5}
            onClick={() => {
              setSelectedType(5)
              setSelectedNav('all')
            }}
            icon={<Wrench className="size-5" />}
            label="Tools"
          />
        </div>
        <div className="w-44 border-r border-border bg-secondary/5 flex flex-col shrink-0">
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-4">
              <div className="space-y-1">
                <span className="px-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Library
                </span>
                <NavItem
                  active={selectedNav === 'inbox'}
                  onClick={() => {
                    setSelectedNav('inbox')
                    setSelectedFolderId(null)
                  }}
                  icon={<Inbox className="size-3.5" />}
                  label="Inbox"
                />
                <NavItem
                  active={selectedNav === 'favorites'}
                  onClick={() => {
                    setSelectedNav('favorites')
                    setSelectedFolderId(null)
                  }}
                  icon={<Star className="size-3.5" />}
                  label="Favorites"
                />
                <NavItem
                  active={selectedNav === 'all'}
                  onClick={() => {
                    setSelectedNav('all')
                    setSelectedFolderId(null)
                  }}
                  icon={<List className="size-3.5" />}
                  label="All Snippets"
                />
                <NavItem
                  active={selectedNav === 'trash'}
                  onClick={() => {
                    setSelectedNav('trash')
                    setSelectedFolderId(null)
                  }}
                  icon={<Trash2 className="size-3.5" />}
                  label="Trash"
                />
              </div>
              {visibleFolders.length ? (
                <div className="space-y-1">
                  <span className="px-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    Folders
                  </span>
                  {visibleFolders.map((f) => (
                    <NavItem
                      key={f.id}
                      active={selectedNav === 'folder' && selectedFolderId === f.id}
                      onClick={() => {
                        setSelectedNav('folder')
                        setSelectedFolderId(f.id)
                      }}
                      icon={<Folder className="size-3.5" />}
                      label={f.name}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </div>
        <div className="flex-1 flex flex-col min-w-0 bg-background">
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {loading ? (
                <div className="flex h-48 flex-col items-center justify-center text-muted-foreground">
                  <span className="text-xs font-medium">Loading snippets</span>
                </div>
              ) : null}
              {loadError ? (
                <div className="flex h-48 flex-col items-center justify-center px-6 text-center text-muted-foreground">
                  <span className="text-xs font-medium">{loadError}</span>
                </div>
              ) : null}
              {!loading && !loadError && data?.truncated ? (
                <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  Showing a bounded subset of this vault.
                </div>
              ) : null}
              {!loading &&
                !loadError &&
                filteredSnippets.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => handleCopy(s)}
                    className="group flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent cursor-pointer transition-colors"
                  >
                    <div className="flex flex-col min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium truncate">{s.name}</span>
                        <span className="text-[9px] text-muted-foreground uppercase font-mono px-1 bg-secondary/50 rounded shrink-0">
                          {s.language}
                        </span>
                      </div>
                      {previewLines > 0 && (
                        <div className="text-[10px] text-muted-foreground font-mono leading-tight mt-1 line-clamp-2 max-h-[2.4em] overflow-hidden">
                          {s.content
                            .split('\n')
                            .filter((l) => l.trim())
                            .slice(0, previewLines)
                            .join('\n')}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="size-7"
                        onClick={(e) => {
                          e.stopPropagation()
                          setViewingSnippet(s)
                        }}
                      >
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                ))}
              {!loading && !loadError && filteredSnippets.length === 0 && (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                  <span className="text-xs font-medium">No snippets found</span>
                </div>
              )}
            </div>
          </ScrollArea>
          <div className="p-2 border-t border-border bg-secondary/20 flex justify-between items-center shrink-0">
            <span className="text-[10px] text-muted-foreground px-2">
              {filteredSnippets.length} snippets
            </span>
            <Button
              variant="outline"
              size="xs"
              className="h-7 gap-1.5 text-xs px-2"
              onClick={() =>
                setEditingSnippet({
                  name: '',
                  content: '',
                  language: 'markdown',
                  tags: [],
                  type: selectedType
                })
              }
            >
              <Plus className="size-3" />
              New Snippet
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TypeIcon({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            active && 'bg-accent text-accent-foreground'
          )}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function NavItem({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-accent transition-colors truncate ${active ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground'}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}
