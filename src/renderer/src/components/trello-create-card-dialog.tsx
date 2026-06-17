import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react'
import type { TrelloBoard, TrelloCard, TrelloList } from '../../../shared/trello-types'
import { useAppStore } from '@/store'
import { trelloCreateCard } from '@/runtime/runtime-trello-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TrelloIcon } from '@/components/icons/TrelloIcon'

type TrelloCreateCardDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  boards: TrelloBoard[]
  defaultBoardId?: string
  onCreated: (card: TrelloCard) => void
}
type TrelloCreateCardDialogBodyProps = Omit<TrelloCreateCardDialogProps, 'open'>

export function TrelloCreateCardDialog({
  open,
  onOpenChange,
  boards,
  defaultBoardId,
  onCreated
}: TrelloCreateCardDialogProps): React.JSX.Element {
  const dialogSeed = `${defaultBoardId ?? ''}:${boards.map((board) => board.id).join(',')}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <TrelloCreateCardDialogBody
          key={dialogSeed}
          boards={boards}
          defaultBoardId={defaultBoardId}
          onOpenChange={onOpenChange}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  )
}

function TrelloCreateCardDialogBody({
  onOpenChange,
  boards,
  defaultBoardId,
  onCreated
}: TrelloCreateCardDialogBodyProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const fetchTrelloLists = useAppStore((s) => s.fetchTrelloLists)
  const fetchTrelloCard = useAppStore((s) => s.fetchTrelloCard)
  const [boardId, setBoardId] = useState(
    defaultBoardId && defaultBoardId !== 'all' ? defaultBoardId : (boards[0]?.id ?? '')
  )
  const [lists, setLists] = useState<TrelloList[]>([])
  const [listId, setListId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [loadingLists, setLoadingLists] = useState(false)
  const listRequestIdRef = useRef(0)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === boardId) ?? null,
    [boardId, boards]
  )

  const selectedList = useMemo(
    () => lists.find((list) => list.id === listId) ?? null,
    [listId, lists]
  )

  const loadListsForBoard = useCallback(
    async (nextBoardId: string): Promise<void> => {
      if (!nextBoardId) {
        setLists([])
        setListId('')
        return
      }
      const requestId = ++listRequestIdRef.current
      setLoadingLists(true)
      setError(null)
      try {
        const nextLists = (await fetchTrelloLists(nextBoardId)).filter((list) => !list.closed)
        if (requestId !== listRequestIdRef.current) {
          return
        }
        setLists(nextLists)
        setListId((prev) =>
          nextLists.some((list) => list.id === prev) ? prev : (nextLists[0]?.id ?? '')
        )
      } catch (err) {
        if (requestId !== listRequestIdRef.current) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load Trello lists.')
      } finally {
        if (requestId === listRequestIdRef.current) {
          setLoadingLists(false)
        }
      }
    },
    [fetchTrelloLists]
  )

  useEffect(() => {
    void loadListsForBoard(boardId)
  }, [boardId, loadListsForBoard])

  useEffect(
    () => () => {
      listRequestIdRef.current += 1
    },
    []
  )

  const reset = (): void => {
    setTitle('')
    setDescription('')
    setError(null)
  }

  const handleCreate = async (): Promise<void> => {
    if (creating) {
      return
    }
    if (loadingLists) {
      setError('Wait for Trello lists to finish loading before creating the card.')
      return
    }
    if (!boardId || !listId || !title.trim()) {
      setError('Board, list, and title are required.')
      return
    }
    const selectedListForSubmit = lists.find((list) => list.id === listId)
    // Validate selected list still belongs to the current board.
    if (!selectedListForSubmit || selectedListForSubmit.idBoard !== boardId) {
      setError(
        'Selected list does not belong to the current board. Re-select a list and try again.'
      )
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await trelloCreateCard(settings, {
        idBoard: boardId,
        idList: listId,
        name: title.trim(),
        desc: description.trim() || undefined
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      const card = await fetchTrelloCard(result.id, { force: true })
      if (card) {
        onCreated(card)
      } else {
        onCreated({
          id: result.id,
          shortId: result.id.slice(-8),
          shortLink: result.shortLink,
          name: title.trim(),
          desc: description.trim() || '',
          url: result.url,
          shortUrl: result.url,
          closed: false,
          dueComplete: false,
          due: null,
          idBoard: boardId,
          idList: listId,
          boardName: selectedBoard?.name,
          listName: selectedListForSubmit.name,
          labels: [],
          members: [],
          dateLastActivity: new Date().toISOString()
        })
      }
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Trello card.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <DialogContent
      showCloseButton={false}
      className="sm:max-w-2xl bg-background border-border shadow-2xl p-0 overflow-hidden flex flex-col gap-0 rounded-xl"
      onKeyDown={(event) => {
        const isMac = navigator.userAgent.includes('Mac')
        if ((isMac ? event.metaKey : event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          void handleCreate()
        }
      }}
    >
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-3 bg-muted/10">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            New Card
          </span>
          <span className="text-muted-foreground/40 text-xs">/</span>
          <TrelloIcon className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">
            {selectedBoard?.name ?? 'Select board'}
          </span>
        </div>
        <button
          onClick={() => onOpenChange(false)}
          className="text-muted-foreground hover:text-foreground p-1 rounded-md transition-colors"
          disabled={creating}
          aria-label="Close create Trello card dialog"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex flex-col px-6 py-4 gap-3">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void handleCreate()
            }
          }}
          placeholder="Card title"
          disabled={creating}
          className="text-lg font-semibold bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:ring-0 p-0 placeholder:text-muted-foreground/40 text-foreground w-full"
        />

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add description..."
          rows={5}
          disabled={creating}
          className="w-full min-w-0 text-sm bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:ring-0 p-0 placeholder:text-muted-foreground/45 text-foreground resize-none max-h-60 overflow-y-auto scrollbar-sleek py-1"
        />

        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-4 mt-2">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={creating || boards.length === 0}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
              >
                <TrelloIcon className="size-3.5 text-muted-foreground/70" />
                <span className="truncate max-w-[140px]">{selectedBoard?.name ?? 'Board'}</span>
                <ChevronDown className="size-3 text-muted-foreground/70" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1">
              <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                Board
              </div>
              <div className="max-h-60 overflow-y-auto scrollbar-sleek">
                {boards.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">No boards available</div>
                ) : (
                  boards.map((board) => (
                    <button
                      key={board.id}
                      type="button"
                      onClick={() => setBoardId(board.id)}
                      className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                        boardId === board.id
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-foreground/80'
                      }`}
                    >
                      <span className="truncate">{board.name}</span>
                      {boardId === board.id ? <Check className="size-3 text-foreground" /> : null}
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={creating || loadingLists || lists.length === 0}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
              >
                {loadingLists ? (
                  <LoaderCircle className="size-3.5 animate-spin text-muted-foreground/70" />
                ) : (
                  <span className="size-2 rounded-full bg-muted-foreground/60" />
                )}
                <span className="truncate max-w-[140px]">{selectedList?.name ?? 'List'}</span>
                <ChevronDown className="size-3 text-muted-foreground/70" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1">
              <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                List
              </div>
              {loadingLists ? (
                <div className="flex items-center justify-center p-4">
                  <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto scrollbar-sleek">
                  {lists.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-muted-foreground">
                      No lists available
                    </div>
                  ) : (
                    lists.map((list) => (
                      <button
                        key={list.id}
                        type="button"
                        onClick={() => setListId(list.id)}
                        className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                          listId === list.id
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-foreground/80'
                        }`}
                      >
                        <span className="truncate">{list.name}</span>
                        {listId === list.id ? <Check className="size-3 text-foreground" /> : null}
                      </button>
                    ))
                  )}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        ) : null}
      </div>

      <div className="flex items-center justify-between border-t border-border/60 px-6 py-4 bg-muted/5">
        <span className="text-[10px] text-muted-foreground/60 font-medium">
          {navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+'}Enter to submit.
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={creating}
            className="text-xs h-8 text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={creating || loadingLists || !boardId || !listId || !title.trim()}
            className="text-xs h-8 bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            {creating ? (
              <>
                <LoaderCircle className="size-3.5 animate-spin mr-1" />
                Creating…
              </>
            ) : (
              'Create card'
            )}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}
