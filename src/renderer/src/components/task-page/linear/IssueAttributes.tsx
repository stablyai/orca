import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { ChevronDown, LoaderCircle, Check, UserRound, FolderKanban, Tag } from 'lucide-react'
import { LinearPriorityIcon } from '@/components/linear-priority-icon'
export function TaskPageLinearIssueAttributes({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    newLinearIssueSubmitting,
    newLinearIssueStateId,
    setNewLinearIssueStateId,
    newLinearIssueAssigneeId,
    setNewLinearIssueAssigneeId,
    newLinearIssuePriority,
    setNewLinearIssuePriority,
    newLinearIssueProjectId,
    setNewLinearIssueProjectId,
    newLinearIssueLabelIds,
    setNewLinearIssueLabelIds,
    newLinearIssueProjects,
    newLinearIssueProjectsLoading,
    newLinearStates,
    newLinearMembers,
    newLinearLabels
  } = model
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-4 mt-2">
      {/* Status Selector */}
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
                    style={{
                      backgroundColor: selectedState?.color || '#a3a3a3'
                    }}
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
                  className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${newLinearIssueStateId === s.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2 rounded-full flex-shrink-0"
                      style={{
                        backgroundColor: s.color || '#a3a3a3'
                      }}
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

      {/* Assignee Selector */}
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
                className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${newLinearIssueAssigneeId === null ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'}`}
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
                  className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${newLinearIssueAssigneeId === m.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'}`}
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

      {/* Priority Selector */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            <LinearPriorityIcon priority={newLinearIssuePriority} className="size-3.5" />
            <span>
              {newLinearIssuePriority === 1
                ? translate('auto.components.TaskPage.f373ab1a4f', 'Urgent')
                : newLinearIssuePriority === 2
                  ? translate('auto.components.TaskPage.345b169f1f', 'High')
                  : newLinearIssuePriority === 3
                    ? translate('auto.components.TaskPage.7fd59c18d8', 'Medium')
                    : newLinearIssuePriority === 4
                      ? translate('auto.components.TaskPage.69591944e7', 'Low')
                      : translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.c8d5bec5f7', 'Priority')}
          </div>
          {[
            {
              val: 0,
              label: translate('auto.components.TaskPage.713179dfdc', 'No priority')
            },
            {
              val: 1,
              label: translate('auto.components.TaskPage.f373ab1a4f', 'Urgent')
            },
            {
              val: 2,
              label: translate('auto.components.TaskPage.345b169f1f', 'High')
            },
            {
              val: 3,
              label: translate('auto.components.TaskPage.7fd59c18d8', 'Medium')
            },
            {
              val: 4,
              label: translate('auto.components.TaskPage.69591944e7', 'Low')
            }
          ].map((p) => (
            <button
              key={p.val}
              type="button"
              onClick={() => setNewLinearIssuePriority(p.val)}
              className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${newLinearIssuePriority === p.val ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'}`}
            >
              <div className="flex items-center gap-2">
                <LinearPriorityIcon priority={p.val} className="size-3.5" />
                <span>{p.label}</span>
              </div>
              {newLinearIssuePriority === p.val && <Check className="size-3 text-foreground" />}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Project Selector */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            <FolderKanban className="size-3.5 text-muted-foreground/70" />
            <span className="truncate max-w-[120px]">
              {(() => {
                const selectedProj = newLinearIssueProjects.find(
                  (p) => p.id === newLinearIssueProjectId
                )
                return selectedProj?.name || 'Project'
              })()}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.00022ec0ba', 'Project')}
          </div>
          {newLinearIssueProjectsLoading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div>
              <button
                type="button"
                onClick={() => setNewLinearIssueProjectId(null)}
                className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${newLinearIssueProjectId === null ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'}`}
              >
                <div className="flex items-center gap-2">
                  <FolderKanban className="size-3.5 text-muted-foreground/50" />
                  <span>{translate('auto.components.TaskPage.1742eafc14', 'No Project')}</span>
                </div>
                {newLinearIssueProjectId === null && <Check className="size-3 text-foreground" />}
              </button>
              {newLinearIssueProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setNewLinearIssueProjectId(p.id)}
                  className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${newLinearIssueProjectId === p.id ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'}`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <FolderKanban className="size-3.5 text-muted-foreground/70 flex-shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </div>
                  {newLinearIssueProjectId === p.id && <Check className="size-3 text-foreground" />}
                </button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Labels Selector */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={newLinearIssueSubmitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-border/80 bg-muted/15 hover:bg-muted/50 active:bg-muted transition-colors text-foreground/80 cursor-pointer disabled:opacity-50"
          >
            <Tag className="size-3.5 text-muted-foreground/70" />
            <span>
              {newLinearIssueLabelIds.length === 0
                ? translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')
                : translate('auto.components.TaskPage.eff9800d4b', '{{value0}} label{{value1}}', {
                    value0: newLinearIssueLabelIds.length,
                    value1: newLinearIssueLabelIds.length > 1 ? 's' : ''
                  })}
            </span>
            <ChevronDown className="size-3 text-muted-foreground/70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1 popover-scroll-content scrollbar-sleek">
          <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1 uppercase tracking-wider">
            {translate('auto.components.TaskPage.d0ca4aa1d0', 'Labels')}
          </div>
          {newLinearLabels.loading ? (
            <div className="flex items-center justify-center p-4">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div>
              {newLinearLabels.data.map((l) => {
                const isSelected = newLinearIssueLabelIds.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      if (isSelected) {
                        setNewLinearIssueLabelIds(
                          newLinearIssueLabelIds.filter((id) => id !== l.id)
                        )
                      } else {
                        setNewLinearIssueLabelIds([...newLinearIssueLabelIds, l.id])
                      }
                    }}
                    className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${isSelected ? 'bg-muted font-medium text-foreground' : 'text-foreground/80'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full flex-shrink-0"
                        style={{
                          backgroundColor: l.color || '#a3a3a3'
                        }}
                      />
                      <span>{l.name}</span>
                    </div>
                    {isSelected && <Check className="size-3 text-foreground" />}
                  </button>
                )
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
