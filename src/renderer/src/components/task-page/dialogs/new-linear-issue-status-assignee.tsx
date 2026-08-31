import React from 'react'
import { Check, ChevronDown, LoaderCircle, UserRound } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { MetadataListState } from '@/hooks/useMetadataListRequest'
import { translate } from '@/i18n/i18n'
import type {
  LinearMember,
  LinearWorkflowState
} from '../../../../../shared/linear/workspace-types'

export type NewLinearIssueStatusAssigneeProps = {
  newLinearIssueSubmitting: boolean
  newLinearStates: MetadataListState<LinearWorkflowState>
  newLinearIssueStateId: string | null
  setNewLinearIssueStateId: (id: string) => void
  newLinearMembers: MetadataListState<LinearMember>
  newLinearIssueAssigneeId: string | null
  setNewLinearIssueAssigneeId: (id: string | null) => void
}

export function NewLinearIssueStatusAssignee({
  newLinearIssueSubmitting,
  newLinearStates,
  newLinearIssueStateId,
  setNewLinearIssueStateId,
  newLinearMembers,
  newLinearIssueAssigneeId,
  setNewLinearIssueAssigneeId
}: NewLinearIssueStatusAssigneeProps): React.JSX.Element {
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            {(() => {
              const selectedState = newLinearStates.data.find((s) => s.id === newLinearIssueStateId)
              return (
                <>
                  <span
                    className="size-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: selectedState?.color || '#a3a3a3' }}
                  />
                  <span>
                    {selectedState?.name ||
                      translate('auto.components.TaskPage.154b0fa623', 'Status')}
                  </span>
                </>
              )
            })()}
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.154b0fa623', 'Status')}
          </div>
          {newLinearStates.loading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div>
              {newLinearStates.data.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setNewLinearIssueStateId(s.id)}
                  className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                    newLinearIssueStateId === s.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-foreground/80'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: s.color || '#a3a3a3' }}
                    />
                    <span>{s.name}</span>
                  </div>
                  {newLinearIssueStateId === s.id && <Check className="size-3 text-foreground" />}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            {(() => {
              const selectedAssignee = newLinearMembers.data.find(
                (m) => m.id === newLinearIssueAssigneeId
              )
              if (selectedAssignee) {
                return (
                  <>
                    {selectedAssignee.avatarUrl ? (
                      <img
                        src={selectedAssignee.avatarUrl}
                        alt={selectedAssignee.displayName}
                        className="size-3.5 rounded-full flex-shrink-0"
                      />
                    ) : (
                      <UserRound className="size-3.5 text-muted-foreground/70" />
                    )}
                    <span className="truncate max-w-[100px]">{selectedAssignee.displayName}</span>
                  </>
                )
              }
              return (
                <>
                  <UserRound className="size-3.5 text-muted-foreground/70" />
                  <span>{translate('auto.components.TaskPage.d2a876ca53', 'Assignee')}</span>
                </>
              )
            })()}
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.d2a876ca53', 'Assignee')}
          </div>
          {newLinearMembers.loading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div>
              <button
                type="button"
                onClick={() => setNewLinearIssueAssigneeId(null)}
                className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                  newLinearIssueAssigneeId === null
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-foreground/80'
                }`}
              >
                <div className="flex items-center gap-2">
                  <UserRound className="size-3.5 text-muted-foreground/50" />
                  <span>{translate('auto.components.TaskPage.42a9160321', 'Unassigned')}</span>
                </div>
                {newLinearIssueAssigneeId === null && <Check className="size-3 text-foreground" />}
              </button>
              {newLinearMembers.data.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setNewLinearIssueAssigneeId(m.id)}
                  className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                    newLinearIssueAssigneeId === m.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-foreground/80'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    {m.avatarUrl ? (
                      <img
                        src={m.avatarUrl}
                        alt={m.displayName}
                        className="size-3.5 rounded-full flex-shrink-0"
                      />
                    ) : (
                      <UserRound className="size-3.5 text-muted-foreground/70" />
                    )}
                    <span className="truncate">{m.displayName}</span>
                  </div>
                  {newLinearIssueAssigneeId === m.id && (
                    <Check className="size-3 text-foreground" />
                  )}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  )
}
